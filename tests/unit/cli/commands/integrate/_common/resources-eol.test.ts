/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  textSnippet,
  wholeFile,
} from '../../../../../../src/cli/commands/integrate/_common/registry';
import type { IntegrationContext } from '../../../../../../src/cli/commands/integrate/_common/registry/types';
import { getDefaultState } from '../../../../../../src/lib/state';

describe('EOL-preserving resource writes', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sonar-cli-eol-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function context(): IntegrationContext {
    return {
      targetRoot: tempDir,
      state: getDefaultState('test'),
      scope: 'project',
      executionMode: 'install',
      resolvedDependencies: new Map(),
    };
  }

  // ---------------------------------------------------------------------------
  // wholeFile
  // ---------------------------------------------------------------------------
  describe('wholeFile', () => {
    it('isApplied returns true when on-disk file differs only by CRLF vs LF', async () => {
      const path = join(tempDir, 'hook');
      const lf = '#!/bin/sh\nsonar hook pre-commit\n';
      const crlf = lf.replace(/\n/g, '\r\n');

      await writeFile(path, crlf, 'utf-8');

      const resource = wholeFile({
        id: 'pre-commit',
        targetPath: path,
        content: lf,
      });

      expect(await resource.isApplied(context())).toBe(true);
    });

    it('isApplied returns false when content differs beyond EOL', async () => {
      const path = join(tempDir, 'hook');
      await writeFile(path, '#!/bin/sh\necho hello\r\n', 'utf-8');

      const resource = wholeFile({
        id: 'pre-commit',
        targetPath: path,
        content: '#!/bin/sh\nsonar hook pre-commit\n',
      });

      expect(await resource.isApplied(context())).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // textSnippet
  // ---------------------------------------------------------------------------
  describe('textSnippet', () => {
    const START = '# sonar:begin my-snippet';
    const END = '# sonar:end my-snippet';

    function makeResource(content = 'sonar analyze\n') {
      return textSnippet({
        id: 'my-snippet',
        targetPath: join(tempDir, 'config'),
        content,
        startMarker: START,
        endMarker: END,
      });
    }

    it('apply writes the managed block using the existing file EOL (CRLF file → CRLF block)', async () => {
      const path = join(tempDir, 'config');
      // File already has CRLF line endings
      await writeFile(path, 'existing content\r\n', 'utf-8');

      const resource = makeResource('sonar analyze\n');
      await resource.apply(context());

      const written = await readFile(path, 'utf-8');
      // The managed block itself must use CRLF
      expect(written).toContain(`${START}\r\n`);
      expect(written).toContain(`\r\n${END}`);
      // No stray bare LF (outside of the CRLF sequences)
      expect(written.replace(/\r\n/g, '')).not.toContain('\n');
    });

    it('apply writes the managed block using LF when the existing file uses LF', async () => {
      const path = join(tempDir, 'config');
      await writeFile(path, 'existing content\n', 'utf-8');

      const resource = makeResource('sonar analyze\n');
      await resource.apply(context());

      const written = await readFile(path, 'utf-8');
      expect(written).toContain(`${START}\n`);
      expect(written).not.toContain('\r\n');
    });

    it('apply replaces an existing managed block in a CRLF file using CRLF', async () => {
      const path = join(tempDir, 'config');
      // File already has a managed block with CRLF endings
      const existing = `before\r\n${START}\r\nold command\r\n${END}\r\nafter\r\n`;
      await writeFile(path, existing, 'utf-8');

      const resource = makeResource('sonar analyze\n');
      await resource.apply(context());

      const written = await readFile(path, 'utf-8');
      expect(written).toContain(`${START}\r\nsonar analyze\r\n${END}`);
      expect(written).toContain('before\r\n');
      expect(written).toContain('\r\nafter\r\n');
      expect(written.replace(/\r\n/g, '')).not.toContain('\n');
    });

    it('isApplied returns true for a CRLF file when the template content uses LF', async () => {
      const path = join(tempDir, 'config');
      const lf = `${START}\nsonar analyze\n${END}\n`;
      const crlf = lf.replace(/\n/g, '\r\n');
      await writeFile(path, crlf, 'utf-8');

      const resource = makeResource('sonar analyze\n');
      expect(await resource.isApplied(context())).toBe(true);
    });

    it('isApplied returns false when the managed block content differs', async () => {
      const path = join(tempDir, 'config');
      const crlf = `${START}\r\nsome other command\r\n${END}\r\n`;
      await writeFile(path, crlf, 'utf-8');

      const resource = makeResource('sonar analyze\n');
      expect(await resource.isApplied(context())).toBe(false);
    });
  });
});
