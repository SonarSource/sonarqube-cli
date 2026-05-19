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

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getPreCommitHookScript } from '../../../../../../src/cli/commands/integrate/git/tools/native';
import { nativeGitHookResource } from '../../../../../../src/cli/commands/integrate/git/tools/native/resource';
import { getDefaultState } from '../../../../../../src/lib/state';

const TEMP_DIR = join(process.cwd(), 'tests', 'unit', '.git-native-resource-tmp');

describe('nativeGitHookResource', () => {
  beforeEach(() => {
    mkdirSync(TEMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  it('treats CRLF hook files as already applied', async () => {
    const resource = nativeGitHookResource({
      id: 'hook-file',
      displayName: 'pre-commit hook',
      hook: 'pre-commit',
    });
    writeFileSync(
      join(TEMP_DIR, 'pre-commit'),
      getPreCommitHookScript().replace(/\n/g, '\r\n'),
      'utf-8',
    );

    const isApplied = await resource.isApplied({
      state: getDefaultState('test'),
      targetRoot: TEMP_DIR,
      scope: 'global',
    });

    expect(isApplied).toBe(true);
  });
});
