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

import { InvalidOptionError } from '../../../../../../src/cli/commands/_common/error';
import { integrateCopilot } from '../../../../../../src/cli/commands/integrate/copilot';
import type { ResolvedAuth } from '../../../../../../src/lib/auth-resolver';
import * as mcpHelper from '../../../../../../src/lib/mcp/mcp-helper';
import type { DiscoveredProject } from '../../../../../../src/lib/project-workspace';
import * as discovery from '../../../../../../src/lib/project-workspace';
import { clearMockUiCalls, setMockUi } from '../../../../../../src/ui';

const SERVER_AUTH: ResolvedAuth = {
  token: 'test-token',
  serverUrl: 'https://sonar.example.com',
  connectionType: 'on-premise',
};

describe('integrateCopilot', () => {
  let discoverProjectSpy: ReturnType<typeof spyOn>;
  let setupMcpServerForAgentSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    discoverProjectSpy = spyOn(discovery, 'discoverProject');
    setupMcpServerForAgentSpy = spyOn(mcpHelper, 'setupMcpServerForAgent').mockResolvedValue(
      undefined,
    );
    mockDiscoveredProject({});
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    discoverProjectSpy.mockRestore();
    setupMcpServerForAgentSpy.mockRestore();
  });

  it('calls setupMcpServerForAgent with copilot, discovered rootDir, non-global, and discovered projectKey', async () => {
    mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'discovered-key' });

    await integrateCopilot(SERVER_AUTH, {});

    expect(setupMcpServerForAgentSpy).toHaveBeenCalledWith(
      'copilot',
      '/project/root',
      false,
      'discovered-key',
    );
  });

  it('uses --project override instead of discovered projectKey', async () => {
    mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'discovered-key' });

    await integrateCopilot(SERVER_AUTH, { project: 'override-key' });

    expect(setupMcpServerForAgentSpy).toHaveBeenCalledWith(
      'copilot',
      '/project/root',
      false,
      'override-key',
    );
  });

  it('passes isGlobal=true when --global is set', async () => {
    mockDiscoveredProject({ rootDir: '/project/root' });

    await integrateCopilot(SERVER_AUTH, { global: true });

    expect(setupMcpServerForAgentSpy).toHaveBeenCalledWith(
      'copilot',
      '/project/root',
      true,
      undefined,
    );
  });

  it('throws InvalidOptionError when both --global and --project are provided', () => {
    expect(integrateCopilot(SERVER_AUTH, { global: true, project: 'my-project' })).rejects.toThrow(
      new InvalidOptionError(
        '--global and --project are mutually exclusive; please specify only one scope.',
      ),
    );
  });

  it('still calls setupMcpServerForAgent when discoverProject finds no config (non-git, unconfigured dir)', async () => {
    mockDiscoveredProject({ rootDir: '/no-config-dir', isGitRepo: false, configSources: [] });

    await integrateCopilot(SERVER_AUTH, {});

    expect(setupMcpServerForAgentSpy).toHaveBeenCalledWith(
      'copilot',
      '/no-config-dir',
      false,
      undefined,
    );
  });

  function mockDiscoveredProject(project: Partial<DiscoveredProject>) {
    discoverProjectSpy.mockResolvedValue({
      rootDir: project.rootDir ?? process.cwd(),
      isGitRepo: project.isGitRepo ?? false,
      serverUrl: project.serverUrl,
      organization: project.organization,
      projectKey: project.projectKey,
      configSources: project.configSources ?? [],
    });
  }
});
