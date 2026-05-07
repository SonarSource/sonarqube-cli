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

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  readOrInitJson,
  UNIX_SONAR_COMMAND_GUARD,
  unixTemplate,
  WINDOWS_SONAR_COMMAND_GUARD,
  windowsTemplate,
  writeHookScript,
} from '../../../../../../src/cli/commands/integrate/_common/hooks';

const IS_WINDOWS = process.platform === 'win32';

describe('unixTemplate', () => {
  it('starts with a bash shebang, includes the command guard, and embeds the command verbatim', () => {
    const body = unixTemplate('sonar hook claude-pre-tool-use');
    expect(body.startsWith('#!/bin/bash\n')).toBe(true);
    expect(body).toContain(UNIX_SONAR_COMMAND_GUARD);
    expect(body).toContain('sonar hook claude-pre-tool-use');
  });
});

describe('windowsTemplate', () => {
  it('includes the command guard, reads stdin, and pipes it to the command', () => {
    const body = windowsTemplate('sonar hook claude-pre-tool-use');
    expect(body).toContain(WINDOWS_SONAR_COMMAND_GUARD);
    expect(body).toContain('$stdinData = [Console]::In.ReadToEnd()');
    expect(body).toContain('$stdinData | & sonar hook claude-pre-tool-use');
  });
});

describe('writeHookScript', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'sonar-hooks-test-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writes the correct platform body, uses the platform extension, and returns an absolute path', async () => {
    const scriptDir = join(workDir, 'scripts');

    const written = await writeHookScript(scriptDir, 'pretool', 'UNIX_BODY', 'WINDOWS_BODY');

    const expectedExt = IS_WINDOWS ? '.ps1' : '.sh';
    expect(written.endsWith(`pretool${expectedExt}`)).toBe(true);
    expect(written.startsWith(scriptDir)).toBe(true);
    expect(statSync(written).isFile()).toBe(true);
    expect(readFileSync(written, 'utf-8')).toBe(IS_WINDOWS ? 'WINDOWS_BODY' : 'UNIX_BODY');
  });

  it('creates the script directory recursively when missing', async () => {
    const scriptDir = join(workDir, 'a', 'b', 'c');

    const written = await writeHookScript(scriptDir, 'pretool', 'unix', 'windows');

    expect(statSync(scriptDir).isDirectory()).toBe(true);
    expect(statSync(written).isFile()).toBe(true);
  });

  it.skipIf(IS_WINDOWS)('writes the script with mode 0o755 on Unix', async () => {
    const scriptDir = join(workDir, 'scripts');

    const written = await writeHookScript(scriptDir, 'pretool', 'unix', 'windows');

    // Mask out file-type bits; only the permission bits matter.
    const mode = statSync(written).mode & 0o777;
    expect(mode).toBe(0o755);
  });
});

describe('readOrInitJson', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'sonar-readjson-test-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns the default value when the file does not exist', async () => {
    const missing = join(workDir, 'missing.json');

    const result = await readOrInitJson(missing, { hooks: {} });

    expect(result).toEqual({ hooks: {} });
  });

  it('returns the default value when the file contains malformed JSON', async () => {
    const path = join(workDir, 'bad.json');
    writeFileSync(path, '{ not valid json !!!', 'utf-8');

    const result = await readOrInitJson(path, { fallback: true });

    expect(result).toEqual({ fallback: true });
  });

  it('parses and returns the file contents when the JSON is valid', async () => {
    const path = join(workDir, 'good.json');
    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: ['x'] } }), 'utf-8');

    const result = await readOrInitJson<{ hooks: { PreToolUse: string[] } }>(path, {
      hooks: { PreToolUse: [] },
    });

    expect(result.hooks.PreToolUse).toEqual(['x']);
  });
});
