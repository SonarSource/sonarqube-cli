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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  appendToCursorIgnore,
  CURSOR_IGNORE_MARKER,
} from '../../../../../src/cli/commands/hook/cursor-ignore';
import { CURSOR_IGNORE_FILE } from '../../../../../src/lib/config-constants';

describe('appendToCursorIgnore', () => {
  let projectRoot: string;

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function createProject(): void {
    projectRoot = mkdtempSync(join(tmpdir(), 'sonar-cursor-ignore-'));
    mkdirSync(join(projectRoot, '.cursor'));
    mkdirSync(join(projectRoot, 'src', 'cli'), { recursive: true });
    writeFileSync(join(projectRoot, 'src', 'cli', 'secret.ts'), 'const token = "ghp_test";');
  }

  it('creates .cursorignore with a project-relative path', () => {
    createProject();
    const filePath = join(projectRoot, 'src', 'cli', 'secret.ts');

    const result = appendToCursorIgnore(filePath);

    expect(result).toBe(true);
    const content = readFileSync(join(projectRoot, CURSOR_IGNORE_FILE), 'utf-8');
    expect(content).toContain(CURSOR_IGNORE_MARKER);
    expect(content).toContain('src/cli/secret.ts');
  });

  it('appends to an existing .cursorignore without duplicating entries', () => {
    createProject();
    const filePath = join(projectRoot, 'src', 'cli', 'secret.ts');
    writeFileSync(join(projectRoot, CURSOR_IGNORE_FILE), 'node_modules/\n');

    const first = appendToCursorIgnore(filePath);
    const second = appendToCursorIgnore(filePath);

    expect(first).toBe(true);
    expect(second).toBe(true);
    const content = readFileSync(join(projectRoot, CURSOR_IGNORE_FILE), 'utf-8');
    expect(content.match(/src\/cli\/secret\.ts/g)).toHaveLength(1);
    expect(content).toContain('node_modules/');
  });

  it('is a no-op when no Cursor project root is found', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'sonar-cursor-ignore-'));
    const filePath = join(projectRoot, 'orphan.ts');
    writeFileSync(filePath, 'x');

    const result = appendToCursorIgnore(filePath);

    expect(result).toBe(false);
    expect(() => readFileSync(join(projectRoot, CURSOR_IGNORE_FILE))).toThrow();
  });
});
