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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CommandFailedError } from '../../../../../src/commands/_common/error.ts';
import {
  buildProjectScopeLabel,
  isGlobalIntegrateScope,
  resolveIntegrateScope,
} from '../../../../../src/commands/integrate/_common/integrate-scope.ts';
import {
  clearMockUiCalls,
  findMockUiCall,
  getMockUiCalls,
  queueMockResponse,
  setMockUi,
} from '../../../../../src/ui';

describe('resolveIntegrateScope', () => {
  beforeEach(() => setMockUi(true));
  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
  });

  it('returns global when --global is set', async () => {
    expect(await resolveIntegrateScope({ global: true })).toBe('global');
    expect(getMockUiCalls().some((c) => c.method === 'selectPrompt')).toBe(false);
  });

  it('defaults to project with an info line in non-interactive mode', async () => {
    expect(await resolveIntegrateScope({ nonInteractive: true })).toBe('project');
    expect(findMockUiCall('info', 'defaulting to this project')).toBeDefined();
  });

  it('includes the project path in the non-interactive default info line', async () => {
    expect(
      await resolveIntegrateScope({ nonInteractive: true, projectRoot: '/workspace/my-repo' }),
    ).toBe('project');
    expect(findMockUiCall('info', 'defaulting to this project (/workspace/my-repo)')).toBeDefined();
  });

  it('returns project without prompting when a project key was provided', async () => {
    expect(await resolveIntegrateScope({ projectKey: 'my-project' })).toBe('project');
    expect(getMockUiCalls().some((c) => c.method === 'selectPrompt')).toBe(false);
  });

  it('prompts interactively when a project root is provided', async () => {
    queueMockResponse('project');
    expect(await resolveIntegrateScope({ projectRoot: '/workspace/my-repo' })).toBe('project');
    expect(getMockUiCalls().some((c) => c.method === 'selectPrompt')).toBe(true);
  });

  it('prompts interactively when scope flags are omitted', async () => {
    queueMockResponse('global');
    expect(await resolveIntegrateScope({})).toBe('global');
    expect(
      getMockUiCalls().some(
        (c) =>
          c.method === 'selectPrompt' &&
          typeof c.args[0] === 'string' &&
          c.args[0].includes('Where should SonarQube be integrated?'),
      ),
    ).toBe(true);
  });

  it('throws CommandFailedError when the user cancels the scope prompt', () => {
    queueMockResponse(null);
    expect(resolveIntegrateScope({})).rejects.toThrow(CommandFailedError);
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
