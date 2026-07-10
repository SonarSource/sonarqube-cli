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

import { resolveSqaaBranch } from '../../../../../src/cli/commands/analyze/sqaa-changeset';
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

describe('resolveSqaaBranch', () => {
  it('returns explicit branch without calling git branch detection', async () => {
    mockGitResponses({
      'rev-parse --show-toplevel': `${process.cwd()}\n`,
      'branch --show-current': 'main\n',
    });

    expect(await resolveSqaaBranch('override-branch')).toBe('override-branch');
    expect(
      spawnProcessSpy.mock.calls.some(([, args]: [string, string[]]) => args[0] === 'branch'),
    ).toBe(false);
  });

  it('auto-detects when explicit branch is omitted', async () => {
    mockGitResponses({
      'rev-parse --show-toplevel': `${process.cwd()}\n`,
      'branch --show-current': 'develop\n',
    });

    expect(await resolveSqaaBranch(undefined, '/path/to/repo/src/file.ts')).toBe('develop');
  });
});
