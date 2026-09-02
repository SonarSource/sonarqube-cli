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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CURSOR_IGNORE_FILE } from '@/core/config-constants.ts';

import {
  appendToCursorIgnore,
  CURSOR_IGNORE_MARKER,
  workspaceRootToPath,
} from '../../../../src/commands/hook/cursor-ignore.ts';

describe('appendToCursorIgnore', () => {
  /** Everything these specs create lives under here, workspace roots included. */
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sonar-cursor-ignore-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Create a workspace root and return it the way Cursor reports it in `workspace_roots`: a URI
   * path component, so a Windows drive path gains a leading slash and a lowercase drive letter. On
   * POSIX the native path is already in that form. Keeps these specs faithful to the real payload.
   */
  function cursorRoot(...segments: string[]): string {
    const root = join(tempDir, ...segments);
    mkdirSync(root, { recursive: true });
    const uriStyle = root.replaceAll('\\', '/');
    return /^[A-Za-z]:/.test(uriStyle)
      ? `/${uriStyle[0].toLowerCase()}${uriStyle.slice(1)}`
      : uriStyle;
  }

  function secretFile(...segments: string[]): string {
    const filePath = join(tempDir, ...segments);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'const token = "ghp_test";');
    return filePath;
  }

  function ignorePath(...segments: string[]): string {
    return join(tempDir, ...segments, CURSOR_IGNORE_FILE);
  }

  function ignoreLines(...segments: string[]): string[] {
    return readFileSync(ignorePath(...segments), 'utf-8').split('\n');
  }

  it('creates .cursorignore with a workspace-relative path', () => {
    const filePath = secretFile('src', 'cli', 'secret.ts');

    const result = appendToCursorIgnore(filePath, [cursorRoot()]);

    expect(result).toBe(true);
    const lines = ignoreLines();
    expect(lines).toContain(CURSOR_IGNORE_MARKER);
    expect(lines).toContain('src/cli/secret.ts');
  });

  it('appends to an existing .cursorignore without duplicating entries', () => {
    const filePath = secretFile('src', 'cli', 'secret.ts');
    writeFileSync(ignorePath(), 'node_modules/\n');
    const roots = [cursorRoot()];

    expect(appendToCursorIgnore(filePath, roots)).toBe(true);
    expect(appendToCursorIgnore(filePath, roots)).toBe(true);

    const lines = ignoreLines();
    expect(lines.filter((line) => line === 'src/cli/secret.ts')).toHaveLength(1);
    expect(lines).toContain('node_modules/');
  });

  it('is a no-op when no workspace root contains the file', () => {
    // As when an agent reads ~/.aws/credentials, outside the workspace entirely.
    const filePath = secretFile('outside', 'orphan.ts');

    const result = appendToCursorIgnore(filePath, [cursorRoot('workspace')]);

    expect(result).toBe(false);
    expect(existsSync(ignorePath('workspace'))).toBe(false);
    expect(existsSync(ignorePath('outside'))).toBe(false);
  });

  it('is a no-op when the payload carries no workspace roots', () => {
    const filePath = secretFile('src', 'secret.ts');

    expect(appendToCursorIgnore(filePath, [])).toBe(false);
    expect(existsSync(ignorePath())).toBe(false);
  });

  it('picks the workspace root that contains the file when several are open', () => {
    const filePath = secretFile('b', 'src', 'secret.ts');

    const result = appendToCursorIgnore(filePath, [cursorRoot('a'), cursorRoot('b')]);

    expect(result).toBe(true);
    expect(ignoreLines('b')).toContain('src/secret.ts');
    expect(existsSync(ignorePath('a'))).toBe(false);
  });

  it('prefers the deepest workspace root when roots are nested', () => {
    const filePath = secretFile('packages', 'app', 'src', 'secret.ts');

    const result = appendToCursorIgnore(filePath, [cursorRoot(), cursorRoot('packages', 'app')]);

    expect(result).toBe(true);
    // The inner root owns the .cursorignore closest to the file.
    expect(ignoreLines('packages', 'app')).toContain('src/secret.ts');
    expect(existsSync(ignorePath())).toBe(false);
  });

  it('strips the URI leading slash only from a Windows drive root', () => {
    expect(workspaceRootToPath('/c:/Users/tom/proj')).toBe('c:/Users/tom/proj');
    expect(workspaceRootToPath('/C:/Users/tom/proj')).toBe('C:/Users/tom/proj');
    expect(workspaceRootToPath('/home/tom/proj')).toBe('/home/tom/proj');
    expect(workspaceRootToPath(String.raw`c:\Users\tom\proj`)).toBe(String.raw`c:\Users\tom\proj`);
  });
});
