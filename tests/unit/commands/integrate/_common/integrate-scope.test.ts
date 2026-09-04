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

import { CommandFailedError } from '@/core/command-error.ts';

import {
  buildProjectScopeLabel,
  isGlobalIntegrateScope,
  resolveIntegrateScope,
} from '../../../../../src/commands/integrate/_common/integrate-scope.ts';
import { FakeConsole } from '../../../../_common/fake-console.ts';

let fake: FakeConsole;

describe('resolveIntegrateScope', () => {
  beforeEach(() => {
    fake = new FakeConsole();
  });

  it('returns global when --global is set', async () => {
    expect(await resolveIntegrateScope({ global: true, console: fake })).toBe('global');
    expect(fake.calls.some((c) => c.method === 'selectPrompt')).toBe(false);
  });

  it('defaults to project with an info line in non-interactive mode', async () => {
    expect(await resolveIntegrateScope({ nonInteractive: true, console: fake })).toBe('project');
    expect(fake.findCall('info', 'defaulting to this project')).toBeDefined();
  });

  it('includes the project path in the non-interactive default info line', async () => {
    expect(
      await resolveIntegrateScope({
        nonInteractive: true,
        projectRoot: '/workspace/my-repo',
        console: fake,
      }),
    ).toBe('project');
    expect(fake.findCall('info', 'defaulting to this project (/workspace/my-repo)')).toBeDefined();
  });

  it('returns project without prompting when a project key was provided', async () => {
    expect(await resolveIntegrateScope({ projectKey: 'my-project', console: fake })).toBe(
      'project',
    );
    expect(fake.calls.some((c) => c.method === 'selectPrompt')).toBe(false);
  });

  it('prompts interactively when a project root is provided', async () => {
    fake.queueResponse('project');
    expect(await resolveIntegrateScope({ projectRoot: '/workspace/my-repo', console: fake })).toBe(
      'project',
    );
    expect(fake.calls.some((c) => c.method === 'selectPrompt')).toBe(true);
  });

  it('prompts interactively when scope flags are omitted', async () => {
    fake.queueResponse('global');
    expect(await resolveIntegrateScope({ console: fake })).toBe('global');
    expect(
      fake.calls.some(
        (c) =>
          c.method === 'selectPrompt' &&
          typeof c.args[0] === 'string' &&
          c.args[0].includes('Where should SonarQube be integrated?'),
      ),
    ).toBe(true);
  });

  it('throws CommandFailedError when the user cancels the scope prompt', async () => {
    fake.queueResponse(null);
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(resolveIntegrateScope({ console: fake })).rejects.toThrow(CommandFailedError);
  });
});

describe('buildProjectScopeLabel', () => {
  it('normalizes Windows-style paths in the label', () => {
    expect(buildProjectScopeLabel(String.raw`C:\repo\project`)).toBe(
      'This project (C:/repo/project)',
    );
  });
});

describe('isGlobalIntegrateScope', () => {
  it('returns true only for global scope', () => {
    expect(isGlobalIntegrateScope('global')).toBe(true);
    expect(isGlobalIntegrateScope('project')).toBe(false);
  });
});
