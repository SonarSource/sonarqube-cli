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

import { beforeEach, describe, expect, it } from 'bun:test';

import { resolveSqaaContext } from '@/commands/analyze/sqaa-context.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { SonarConnection } from '@/core/server/connection.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

describe('resolveSqaaContext', () => {
  let fake: FakeConsole;

  beforeEach(() => {
    fake = new FakeConsole();
  });

  it('fails when Cloud has no organization and the user named a project', () => {
    expect(() =>
      resolveSqaaContext({ kind: 'no-org', explicitProject: true }, { requireProject: true }, fake),
    ).toThrow(CommandFailedError);
  });

  it('skips with a warning when Cloud has no organization and no project was named', () => {
    expect(
      resolveSqaaContext(
        { kind: 'no-org', explicitProject: false },
        { requireProject: true },
        fake,
      ),
    ).toBeNull();
    expect(fake.findCall('warn', 'SonarQube Cloud organization is required')).toBeDefined();
  });

  it('hands back the groups, ignored files and roots of a resolved run', () => {
    const connection = {} as SonarConnection;
    const groups = [{ projectKey: 'app-a', projectRoot: '/repo/a', files: ['/repo/a/x.ts'] }];

    expect(
      resolveSqaaContext(
        {
          kind: 'resolved',
          connection,
          groups,
          ignored: [
            { path: '/repo/y.ts', reason: 'outside-project' },
            { path: '/repo/z.ts', reason: 'other-connection' },
          ],
          projectRoots: ['/repo/a'],
        },
        { requireProject: true },
        fake,
      ),
    ).toEqual({
      connection,
      groups,
      ignored: [
        { path: '/repo/y.ts', reason: 'outside-project' },
        { path: '/repo/z.ts', reason: 'other-connection' },
      ],
      projectRoots: ['/repo/a'],
    });
  });

  it('fails on a missing project when the command requires one', () => {
    expect(() =>
      resolveSqaaContext({ kind: 'no-project' }, { requireProject: true }, fake),
    ).toThrow(/requires a project/);
  });

  it('skips with a warning on a missing project when the command does not require one', () => {
    expect(resolveSqaaContext({ kind: 'no-project' }, { requireProject: false }, fake)).toBeNull();
    expect(fake.findCall('warn', 'no project configured')).toBeDefined();
  });

  it('skips without a warning on a missing project or organization when asked to skip silently', () => {
    const policy = { requireProject: false, silentSkip: true };

    expect(resolveSqaaContext({ kind: 'no-project' }, policy, fake)).toBeNull();
    expect(resolveSqaaContext({ kind: 'no-org', explicitProject: false }, policy, fake)).toBeNull();
    expect(fake.findCall('warn', 'Vortex analysis skipped')).toBeUndefined();
  });
});
