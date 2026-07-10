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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { resolveCurrentGitBranch } from '../../../../../src/cli/commands/_common/git-worktree';
import * as processLib from '../../../../../src/lib/process.js';

let spawnProcessSpy: ReturnType<typeof spyOn>;

function mockGitResponses(responses: Record<string, string | null>) {
  spawnProcessSpy.mockImplementation((_cmd: string, args: string[]) => {
    const key = args.join(' ');
    if (key in responses) {
      const stdout = responses[key];
      if (stdout === null) {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'git failed' });
      }
      return Promise.resolve({ exitCode: 0, stdout, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  });
}

beforeEach(() => {
  spawnProcessSpy = spyOn(processLib, 'spawnProcess');
});

afterEach(() => {
  spawnProcessSpy.mockRestore();
});

describe('resolveCurrentGitBranch', () => {
  it('returns the current branch name when git reports one', async () => {
    mockGitResponses({
      'rev-parse --show-toplevel': `${process.cwd()}\n`,
      'branch --show-current': 'feature/my-branch\n',
    });

    expect(await resolveCurrentGitBranch(process.cwd())).toBe('feature/my-branch');
  });

  it('returns undefined on detached HEAD (empty branch name)', async () => {
    mockGitResponses({
      'rev-parse --show-toplevel': `${process.cwd()}\n`,
      'branch --show-current': '\n',
      'rev-parse --abbrev-ref HEAD': 'HEAD\n',
    });

    expect(await resolveCurrentGitBranch(process.cwd())).toBeUndefined();
  });

  it('falls back to rev-parse --abbrev-ref HEAD when show-current is unavailable', async () => {
    mockGitResponses({
      'rev-parse --show-toplevel': `${process.cwd()}\n`,
      'branch --show-current': null,
      'rev-parse --abbrev-ref HEAD': 'legacy-branch\n',
    });

    expect(await resolveCurrentGitBranch(process.cwd())).toBe('legacy-branch');
  });

  it('returns undefined when not inside a git repository', async () => {
    mockGitResponses({
      'rev-parse --show-toplevel': null,
    });

    expect(await resolveCurrentGitBranch(process.cwd())).toBeUndefined();
  });
});
