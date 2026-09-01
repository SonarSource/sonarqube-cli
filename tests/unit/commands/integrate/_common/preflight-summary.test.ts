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

import {
  printAgentPreflightSummary,
  printGitPreflightSummary,
} from '@/commands/integrate/_common/preflight-summary.ts';
import * as token from '@/core/auth/token.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import * as processLib from '@/core/process/process.ts';
import type { DiscoveredProject } from '@/core/project-info.ts';
import { ComponentsClient } from '@/core/server/components.ts';
import { OrganizationsClient } from '@/core/server/organizations.ts';
import type { PhaseItem } from '@/core/ui';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '@/core/ui';

const BASE_PROJECT: DiscoveredProject = {
  repoRoot: '/workspace/app',
  projectRoot: '/workspace/app',
  configSources: [],
};

describe('printAgentPreflightSummary', () => {
  let checkTokenStatusSpy: ReturnType<typeof spyOn>;
  let checkComponentSpy: ReturnType<typeof spyOn>;
  let isOrganizationAccessibleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    checkTokenStatusSpy = spyOn(token, 'checkTokenStatus').mockResolvedValue({ status: 'valid' });
    checkComponentSpy = spyOn(ComponentsClient.prototype, 'checkComponent').mockResolvedValue(true);
    isOrganizationAccessibleSpy = spyOn(
      OrganizationsClient.prototype,
      'isOrganizationAccessible',
    ).mockResolvedValue(true);
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    checkTokenStatusSpy.mockRestore();
    checkComponentSpy.mockRestore();
    isOrganizationAccessibleSpy.mockRestore();
  });

  it('renders Connection and Project sections with config source from files', async () => {
    await printAgentPreflightSummary({
      serverUrl: 'https://sonarcloud.io',
      organization: 'my-org',
      token: 'token',
      project: {
        ...BASE_PROJECT,
        configSources: ['sonar-project.properties', '.sonarlint/connectedMode.json'],
      },
      projectKey: 'my-org_app',
    });

    expect(getPhaseItems('Connection').find((i) => i.text === 'Token')?.detail).toBe('valid');
    expect(getPhaseItems('Project').find((i) => i.text === 'Config source')?.detail).toBe(
      'sonar-project.properties, .sonarlint/connectedMode.json',
    );
  });

  it('shows setup failed guidance when the server is unreachable', async () => {
    checkTokenStatusSpy.mockResolvedValue({ status: 'unreachable' });

    const error = await captureRejection(
      printAgentPreflightSummary({
        serverUrl: 'https://sonar.example.com',
        token: 'token',
        project: BASE_PROJECT,
      }),
    );

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as Error).message).toBe('Server is unreachable.');

    expect(getPhaseItems('Connection').find((i) => i.text === 'Token')?.detail).toBe('unreachable');
    expect(
      getMockUiCalls().find((c) => c.method === 'outro' && c.args[0] === 'Setup failed'),
    ).toBeDefined();
    expect(
      getMockUiCalls().find(
        (c) => c.method === 'info' && String(c.args[0]).includes('Server could not be reached'),
      ),
    ).toBeDefined();
    expect(
      getMockUiCalls().find(
        (c) => c.method === 'text' && String(c.args[0]).includes('SONAR_HOST_URL'),
      ),
    ).toBeDefined();
  });
});

describe('printGitPreflightSummary', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    spawnSpy = spyOn(processLib, 'spawnProcess').mockImplementation((_cmd, args) => {
      if (args[0] === 'config') {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '.git/hooks', stderr: '' });
    });
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    spawnSpy.mockRestore();
  });

  it('renders Repository section with hooks directory and framework', async () => {
    await printGitPreflightSummary('/repo/root');

    const items = getPhaseItems('Repository');
    expect(items.find((i) => i.text === 'Root')?.detail).toBe('/repo/root');
    expect(items.find((i) => i.text === 'Hooks directory')?.detail).toContain('hooks');
    expect(items.find((i) => i.text === 'Framework')?.detail).toBe('native git hooks');
  });
});

function getPhaseItems(title: string): PhaseItem[] {
  const call = getMockUiCalls().find((c) => c.method === 'phase' && c.args[0] === title);
  return (call?.args[1] ?? []) as PhaseItem[];
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected promise to reject');
}
