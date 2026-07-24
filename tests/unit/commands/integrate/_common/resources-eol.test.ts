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
import { EOL, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getDefaultState } from '@/core/state/state.ts';

import { textSnippet, wholeFile } from '../../../../../src/commands/integrate/_common/registry';
import {
  detectEol,
  equalsIgnoringEol,
  includesIgnoringEol,
  toEol,
} from '../../../../../src/commands/integrate/_common/registry/resources/common.ts';
import type { IntegrationContext } from '../../../../../src/commands/integrate/_common/registry/types.ts';

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

    it('isApplied returns true when surrounding content uses CRLF but the managed block uses LF', async () => {
      const path = join(tempDir, 'config');
      // Mixed: rest of file is CRLF, block itself is LF — e.g. written by a different tool.
      // detectEol returns the platform EOL for mixed content, so renderManagedBlock may produce
      // a block with different endings than the one already in the file.
      await writeFile(path, `before\r\n${START}\nsonar analyze\n${END}\r\nafter\r\n`, 'utf-8');

      const resource = makeResource('sonar analyze\n');
      expect(await resource.isApplied(context())).toBe(true);
    });

    it('isApplied returns true when surrounding content uses LF but the managed block uses CRLF', async () => {
      const path = join(tempDir, 'config');
      await writeFile(path, `before\n${START}\r\nsonar analyze\r\n${END}\nafter\n`, 'utf-8');

      const resource = makeResource('sonar analyze\n');
      expect(await resource.isApplied(context())).toBe(true);
    });
  });
});

describe('includesIgnoringEol', () => {
  it('returns true when content includes substring with the same line endings', () => {
    expect(includesIgnoringEol('a\nb\nc', 'a\nb')).toBe(true);
  });

  it('returns true when content uses CRLF but substring uses LF', () => {
    expect(includesIgnoringEol('a\r\nb\r\nc', 'a\nb')).toBe(true);
  });

  it('returns true when content uses LF but substring uses CRLF', () => {
    expect(includesIgnoringEol('a\nb\nc', 'a\r\nb')).toBe(true);
  });

  it('returns false when content does not contain the substring', () => {
    expect(includesIgnoringEol('a\nb\nc', 'x\ny')).toBe(false);
  });

  it('returns false when substring is absent regardless of line endings', () => {
    expect(includesIgnoringEol('a\r\nb\r\nc', 'x\r\ny')).toBe(false);
  });
});

describe('toEol', () => {
  it('converts LF to CRLF', () => {
    expect(toEol('a\nb\n', '\r\n')).toBe('a\r\nb\r\n');
  });

  it('converts CRLF to LF', () => {
    expect(toEol('a\r\nb\r\n', '\n')).toBe('a\nb\n');
  });

  it('normalises mixed line endings to the target EOL', () => {
    expect(toEol('a\r\nb\nc\r\n', '\n')).toBe('a\nb\nc\n');
  });

  it('is a no-op when the value already uses the target EOL', () => {
    expect(toEol('a\nb', '\n')).toBe('a\nb');
  });

  it('does not alter a string that contains no line endings', () => {
    expect(toEol('abc', '\r\n')).toBe('abc');
  });
});

describe('detectEol', () => {
  it('returns LF for a string that contains only LF line endings', () => {
    expect(detectEol('a\nb\nc\n')).toBe('\n');
  });

  it('returns CRLF for a string that contains only CRLF line endings', () => {
    expect(detectEol('a\r\nb\r\nc\r\n')).toBe('\r\n');
  });

  it('returns the platform EOL for a string with mixed line endings', () => {
    expect(detectEol('a\r\nb\nc\r\n')).toBe(EOL);
  });

  it('returns LF for a string with no line endings', () => {
    expect(detectEol('abc')).toBe('\n');
  });
});

describe('equalsIgnoringEol', () => {
  it('returns true for identical strings', () => {
    expect(equalsIgnoringEol('a\nb\n', 'a\nb\n')).toBe(true);
  });

  it('returns true when one string uses CRLF and the other uses LF', () => {
    expect(equalsIgnoringEol('a\r\nb\r\n', 'a\nb\n')).toBe(true);
  });

  it('returns true when one string uses LF and the other uses CRLF', () => {
    expect(equalsIgnoringEol('a\nb\n', 'a\r\nb\r\n')).toBe(true);
  });

  it('returns false when the strings differ beyond line endings', () => {
    expect(equalsIgnoringEol('a\nb\n', 'a\nc\n')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(equalsIgnoringEol('', '')).toBe(true);
  });
});
