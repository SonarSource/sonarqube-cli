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

import { homedir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test';

import { CliAuthenticatedContext } from '@/commands/cli-context.ts';
import type { VortexDisposition } from '@/commands/integrate/_common/types.ts';
import { integrateClaude } from '@/commands/integrate/claude';
import * as hooks from '@/commands/integrate/claude/hooks.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import * as token from '@/core/auth/token.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import * as registry from '@/core/framework/features';
import * as gitWorktree from '@/core/host/git/worktree.ts';
import type { DiscoveredProject } from '@/core/project-info.ts';
import * as discovery from '@/core/project-info.ts';
import { SonarQubeClient } from '@/core/server/client.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';
import type { PhaseItem } from '@/core/ui';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '@/core/ui';

const SERVER_AUTH: ResolvedAuth = {
  token: 'test-token',
  serverUrl: 'https://sonar.example.com',
  connectionType: 'on-premise',
};

const CLOUD_AUTH: ResolvedAuth = {
  token: 'test-token',
  orgKey: 'cloud-org',
  serverUrl: 'https://sonarcloud.io',
  connectionType: 'cloud',
};

const SERVER_CTX = new CliAuthenticatedContext(SERVER_AUTH);
const CLOUD_CTX = new CliAuthenticatedContext(CLOUD_AUTH);

function getPhaseItems(title: string): PhaseItem[] {
  const call = getMockUiCalls().find((c) => c.method === 'phase' && c.args[0] === title);
  return (call?.args[1] ?? []) as PhaseItem[];
}

describe('integrateCommand', () => {
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let hasVortexEntitlementSpy: Mock<
    Extract<(typeof SonarQubeClient.prototype)['hasVortexEntitlement'], (...args: any[]) => any>
  >;
  let checkTokenStatusSpy: Mock<
    Extract<(typeof token)['checkTokenStatus'], (...args: any[]) => any>
  >;
  let checkComponentSpy: Mock<
    Extract<(typeof SonarQubeClient.prototype)['checkComponent'], (...args: any[]) => any>
  >;
  let checkOrganizationSpy: Mock<
    Extract<(typeof SonarQubeClient.prototype)['checkOrganization'], (...args: any[]) => any>
  >;
  let discoverProjectSpy: Mock<
    Extract<(typeof discovery)['discoverProject'], (...args: any[]) => any>
  >;
  let installIntegrationSpy: Mock<
    Extract<(typeof registry)['installIntegration'], (...args: any[]) => any>
  >;
  let detectGlobalSecretsHookSpy: Mock<
    Extract<(typeof hooks)['detectGlobalSecretsHook'], (...args: any[]) => any>
  >;
  let getScaEnablementSpy: Mock<
    Extract<(typeof SonarQubeClient.prototype)['getScaEnablement'], (...args: any[]) => any>
  >;
  let resolveRecordedRepoRootSpy: Mock<
    Extract<(typeof gitWorktree)['resolveRecordedRepoRoot'], (...args: any[]) => any>
  >;

  beforeEach(() => {
    setMockUi(true);

    hasVortexEntitlementSpy = spyOn(SonarQubeClient.prototype, 'hasVortexEntitlement');
    hasVortexEntitlementSpy.mockResolvedValue({ status: 'not_entitled' });
    getScaEnablementSpy = spyOn(SonarQubeClient.prototype, 'getScaEnablement').mockResolvedValue(
      'not_enabled',
    );
    resolveRecordedRepoRootSpy = spyOn(gitWorktree, 'resolveRecordedRepoRoot').mockImplementation(
      (projectRoot: string) => Promise.resolve(projectRoot),
    );

    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => {});

    checkTokenStatusSpy = spyOn(token, 'checkTokenStatus').mockResolvedValue({ status: 'valid' });
    checkComponentSpy = spyOn(SonarQubeClient.prototype, 'checkComponent').mockResolvedValue(true);
    checkOrganizationSpy = spyOn(SonarQubeClient.prototype, 'checkOrganization').mockResolvedValue(
      true,
    );
    discoverProjectSpy = spyOn(discovery, 'discoverProject');
    installIntegrationSpy = spyOn(registry, 'installIntegration').mockResolvedValue([]);
    detectGlobalSecretsHookSpy = spyOn(hooks, 'detectGlobalSecretsHook').mockResolvedValue(
      undefined,
    );

    mockDiscoveredProject({});
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    hasVortexEntitlementSpy.mockRestore();
    checkTokenStatusSpy.mockRestore();
    checkComponentSpy.mockRestore();
    checkOrganizationSpy.mockRestore();
    discoverProjectSpy.mockRestore();
    installIntegrationSpy.mockRestore();
    detectGlobalSecretsHookSpy.mockRestore();
    getScaEnablementSpy.mockRestore();
    resolveRecordedRepoRootSpy.mockRestore();
  });

  it('shows intro message', async () => {
    await integrateClaude({}, SERVER_CTX);

    const introText = getMockUiCalls().find(
      (c) =>
        c.method === 'intro' && String(c.args[0]) === 'SonarQube Integration Setup for Claude Code',
    );
    expect(introText).toBeDefined();
  });

  it('shows discovering project spinner', async () => {
    await integrateClaude({}, SERVER_CTX);

    expect(
      getMockUiCalls().some(
        (c) => c.method === 'spinner' && String(c.args[0]) === 'Discovering project...',
      ),
    ).toBe(true);
  });

  it('shows Connection and Project setup summary sections', async () => {
    await integrateClaude({}, CLOUD_CTX);

    expect(getPhaseItems('Connection').some((i) => i.text === 'Server')).toBe(true);
    expect(getPhaseItems('Connection').some((i) => i.text === 'Organization')).toBe(true);
    expect(
      getPhaseItems('Connection').some((i) => i.text === 'Token' && i.detail === 'valid'),
    ).toBe(true);
    expect(getPhaseItems('Project').some((i) => i.text === 'Root')).toBe(true);
  });

  it('validates token against the auth server URL', async () => {
    await integrateClaude({}, SERVER_CTX);

    expect(checkTokenStatusSpy).toHaveBeenCalledWith(SERVER_AUTH.serverUrl, SERVER_AUTH.token);
  });

  it('shows warning when resolved server does not match discovered server', async () => {
    mockDiscoveredProject({ serverUrl: 'https://example-sonarqube.com' });

    await integrateClaude({}, CLOUD_CTX);

    const warnText = getMockUiCalls().find(
      (c) => c.method === 'warn' && String(c.args[0]).includes('Server URL mismatch'),
    );
    expect(warnText).toBeDefined();
  });

  it('shows warning when resolved organization does not match discovered organization', async () => {
    mockDiscoveredProject({ organization: 'an-org' });

    await integrateClaude({}, CLOUD_CTX);

    const warnText = getMockUiCalls().find(
      (c) => c.method === 'warn' && String(c.args[0]).includes('organization mismatch'),
    );
    expect(warnText).toBeDefined();
  });

  it('validates organization is provided when server is SonarQube Cloud', async () => {
    mockDiscoveredProject({});
    const cloudAuthNoOrg: ResolvedAuth = {
      token: 'test-token',
      serverUrl: 'https://sonarcloud.io',
      connectionType: 'cloud',
    };

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(integrateClaude({}, new CliAuthenticatedContext(cloudAuthNoOrg))).rejects.toThrow(
      CommandFailedError,
    );
  });

  it('shows config source from discovered files', async () => {
    mockDiscoveredProject({
      projectKey: 'my-project',
      configSources: ['sonar-project.properties'],
    });

    await integrateClaude({}, SERVER_CTX);

    const configSource = getPhaseItems('Project').find((i) => i.text === 'Config source');
    expect(configSource?.status).toBe('done');
    expect(configSource?.detail).toBe('sonar-project.properties');
  });

  it('shows config source as --project when the CLI flag overrides the key', async () => {
    mockDiscoveredProject({
      projectKey: 'discovered-key',
      configSources: ['sonar-project.properties'],
    });

    await integrateClaude({ project: 'cli-key' }, SERVER_CTX);

    const configSource = getPhaseItems('Project').find((i) => i.text === 'Config source');
    expect(configSource?.status).toBe('info');
    expect(configSource?.detail).toBe('--project');
    expect(getPhaseItems('Project').find((i) => i.text === 'Key')?.detail).toBe('cli-key');
  });

  it('shows config source as none detected when no config file contributed', async () => {
    await integrateClaude({}, SERVER_CTX);

    const configSource = getPhaseItems('Project').find((i) => i.text === 'Config source');
    expect(configSource?.status).toBe('warn');
    expect(configSource?.detail).toBe('none detected');
  });

  it('project key defaults to discovered project key', async () => {
    mockDiscoveredProject({ projectKey: 'project' });

    await integrateClaude({}, SERVER_CTX);

    expect(getPhaseItems('Project').find((i) => i.text === 'Key')?.detail).toBe('project');
  });

  it('project key overrides discovered project key', async () => {
    mockDiscoveredProject({ projectKey: 'project' });

    await integrateClaude({ project: 'override-project' }, SERVER_CTX);

    expect(getPhaseItems('Project').find((i) => i.text === 'Key')?.detail).toBe('override-project');
  });

  it('aborts when token is invalid', async () => {
    checkTokenStatusSpy.mockResolvedValue({ status: 'invalid' });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(integrateClaude({}, SERVER_CTX)).rejects.toThrow('Token is invalid.');
    expect(installIntegrationSpy).not.toHaveBeenCalled();
  });

  it('aborts when server is unreachable', async () => {
    checkTokenStatusSpy.mockResolvedValue({ status: 'unreachable' });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(integrateClaude({}, SERVER_CTX)).rejects.toThrow('Server is unreachable.');
    expect(installIntegrationSpy).not.toHaveBeenCalled();
  });

  it('checks Vortex entitlement', async () => {
    hasVortexEntitlementSpy.mockResolvedValue({ status: 'enabled' });

    await integrateClaude({}, CLOUD_CTX);

    expect(hasVortexEntitlementSpy).toHaveBeenCalledTimes(1);
  });

  it('installs Vortex through the declarative installer in a single call', async () => {
    mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
    mockVortexEntitlement(true);
    getScaEnablementSpy.mockResolvedValue('enabled');

    await integrateClaude({}, CLOUD_CTX);

    expect(installIntegrationSpy).toHaveBeenCalledTimes(1);
    expect(installIntegrationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: 'claude-code',
        auth: CLOUD_AUTH,
        options: expect.objectContaining({
          projectRoot: '/project/root',
          globalSecretsHookExists: false,
          vortexDisposition: 'install',
        }),
        scope: 'project',
        targetRoot: '/project/root',
        attrs: {
          projectKey: 'a-project',
          repoRoot: '/project/root',
          orgKey: 'cloud-org',
          scaEnabled: true,
          serverUrl: 'https://sonarcloud.io',
        },
      }),
    );
  });

  it('requests Vortex removal when the project organization is not entitled', async () => {
    mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
    mockVortexEntitlement(false);

    await integrateClaude({}, CLOUD_CTX);

    expectClaudeInstallCall({
      targetRoot: '/project/root',
      scope: 'project',
      auth: CLOUD_AUTH,
      projectRoot: '/project/root',
      projectKey: 'a-project',
      globalSecretsHookExists: false,
      vortexDisposition: 'remove',
    });
  });

  it('rethrows Vortex installation failures', async () => {
    mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
    mockVortexEntitlement(true);
    installIntegrationSpy.mockRejectedValueOnce(new Error('print failed'));

    let thrown: unknown;
    try {
      await integrateClaude({}, CLOUD_CTX);
    } catch (error) {
      thrown = error;
    }

    if (!(thrown instanceof Error)) {
      throw new Error('Expected integrateClaude to reject');
    }
    expect(thrown.message).toBe('print failed');

    expect(installIntegrationSpy).toHaveBeenCalledTimes(1);
  });

  it('runs migration and installs hooks when setup summary succeeds', async () => {
    mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
    mockVortexEntitlement(true);

    await integrateClaude({}, CLOUD_CTX);

    assertMigrationAndHookInstallationRan(
      'a-project',
      '/project/root',
      undefined,
      false,
      'install',
    );
  });

  it('runs migration and installs hooks when global option is set', async () => {
    mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
    mockVortexEntitlement(true);

    await integrateClaude({ global: true }, CLOUD_CTX);

    // Vortex is project-scoped, so a global install never enables it even when
    // the org is entitled.
    assertMigrationAndHookInstallationRan(
      'a-project',
      '/project/root',
      homedir(),
      true,
      'preserve',
    );
  });

  it('still installs when organization access check fails in the summary', async () => {
    mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
    mockVortexEntitlement(true);
    checkOrganizationSpy.mockResolvedValue(false);

    await integrateClaude({}, CLOUD_CTX);

    assertMigrationAndHookInstallationRan(
      'a-project',
      '/project/root',
      undefined,
      false,
      'install',
    );
  });

  it('requests Vortex removal when project key is missing and entitlement is lost', async () => {
    mockDiscoveredProject({ rootDir: '/projectB/root' });
    mockVortexEntitlement(false);

    await integrateClaude({}, CLOUD_CTX);

    assertMigrationAndHookInstallationRan(undefined, '/projectB/root', undefined, false, 'remove');
  });

  it('aborts integration when sonar-secrets installation fails', async () => {
    installIntegrationSpy.mockRejectedValueOnce(new Error('Network error'));

    let error: unknown;
    try {
      await integrateClaude({}, SERVER_CTX);
    } catch (err) {
      error = err;
    }

    expect((error as Error).message).toBe('Network error');
    expect(installIntegrationSpy).toHaveBeenCalledTimes(1);
  });

  describe('when a global Claude hook is already configured', () => {
    const GLOBAL_HOOK_PATH = `${homedir()}/.claude/hooks/sonar-secrets`;

    beforeEach(() => {
      detectGlobalSecretsHookSpy.mockResolvedValue(GLOBAL_HOOK_PATH);
    });

    it('forwards skipSecretsHooks: true to migrations and skips the declarative secrets-hooks feature', async () => {
      mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });

      await integrateClaude({}, SERVER_CTX);

      expectClaudeInstallCall({
        targetRoot: '/project/root',
        scope: 'project',
        auth: SERVER_AUTH,
        projectRoot: '/project/root',
        projectKey: 'a-project',
        globalSecretsHookExists: true,
        vortexDisposition: 'preserve',
      });
    });

    it('still installs project-scoped Vortex when the org is entitled', async () => {
      mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
      mockVortexEntitlement(true);

      await integrateClaude({}, CLOUD_CTX);

      expectClaudeInstallCall({
        targetRoot: '/project/root',
        scope: 'project',
        auth: CLOUD_AUTH,
        projectRoot: '/project/root',
        projectKey: 'a-project',
        globalSecretsHookExists: true,
        vortexDisposition: 'install',
      });
    });
  });

  describe('when no global Claude hook is configured', () => {
    beforeEach(() => {
      detectGlobalSecretsHookSpy.mockResolvedValue(undefined);
    });

    it('falls back to a project-level install (does not skip secrets hooks)', async () => {
      mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });

      await integrateClaude({}, SERVER_CTX);

      expectClaudeInstallCall({
        targetRoot: '/project/root',
        scope: 'project',
        auth: SERVER_AUTH,
        projectRoot: '/project/root',
        projectKey: 'a-project',
        globalSecretsHookExists: false,
        vortexDisposition: 'preserve',
      });
    });
  });

  describe('when -g (global) is used', () => {
    it('does not probe for a pre-existing global hook', async () => {
      await integrateClaude({ global: true }, SERVER_CTX);

      expect(detectGlobalSecretsHookSpy).not.toHaveBeenCalled();
    });

    it('does not print the "already configured globally" skip notice (no probe is run)', async () => {
      await integrateClaude({ global: true }, SERVER_CTX);

      const skipNotice = getMockUiCalls().find(
        (c) =>
          c.method === 'info' && String(c.args[0]).includes('already configured for SonarQube'),
      );
      expect(skipNotice).toBeUndefined();
    });

    it('skips Vortex (and warns) even when the org is entitled', async () => {
      mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
      mockVortexEntitlement(true);

      await integrateClaude({ global: true }, CLOUD_CTX);

      // Vortex is project-scoped, so a global run never installs it.
      expectClaudeInstallCall({
        targetRoot: homedir(),
        scope: 'global',
        auth: CLOUD_AUTH,
        projectRoot: '/project/root',
        projectKey: 'a-project',
        globalSecretsHookExists: false,
        vortexDisposition: 'preserve',
      });

      const warnNotice = getMockUiCalls().find(
        (c) => c.method === 'warn' && String(c.args[0]).includes('not supported with --global'),
      );
      expect(warnNotice).toBeDefined();
    });

    it('requests Vortex removal when a global run finds the org is not entitled', async () => {
      mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
      mockVortexEntitlement(false);

      await integrateClaude({ global: true }, CLOUD_CTX);

      expectClaudeInstallCall({
        targetRoot: homedir(),
        scope: 'global',
        auth: CLOUD_AUTH,
        projectRoot: '/project/root',
        projectKey: 'a-project',
        globalSecretsHookExists: false,
        vortexDisposition: 'remove',
      });
    });
  });

  function mockDiscoveredProject(project: Partial<DiscoveredProject>) {
    discoverProjectSpy.mockResolvedValue({
      rootDir: project.rootDir || process.cwd(),
      isGitRepo: project.isGitRepo ?? false,
      serverUrl: project.serverUrl,
      organization: project.organization,
      projectKey: project.projectKey,
      configSources: project.configSources ?? [],
    });
  }

  function mockVortexEntitlement(hasEntitlement: boolean) {
    hasVortexEntitlementSpy.mockResolvedValue({
      status: hasEntitlement ? 'enabled' : 'not_entitled',
    });
  }

  function assertMigrationAndHookInstallationRan(
    projectKey: string | undefined,
    projectRootDir: string,
    globalDir: string | undefined,
    isGlobal: boolean,
    vortexDisposition: VortexDisposition,
    auth: ResolvedAuth = CLOUD_AUTH,
    skipSecretsHooks = false,
  ): void {
    const mainTargetRoot = globalDir ?? projectRootDir;
    const mainScope = isGlobal ? 'global' : 'project';
    expectClaudeInstallCall({
      targetRoot: mainTargetRoot,
      scope: mainScope,
      auth,
      projectRoot: projectRootDir,
      projectKey,
      globalSecretsHookExists: skipSecretsHooks,
      vortexDisposition,
    });
  }

  function expectClaudeInstallCall({
    targetRoot,
    scope,
    auth,
    projectRoot,
    projectKey,
    globalSecretsHookExists,
    vortexDisposition,
  }: {
    targetRoot: string;
    scope: 'global' | 'project';
    auth: ResolvedAuth;
    projectRoot: string;
    projectKey?: string;
    globalSecretsHookExists: boolean;
    vortexDisposition: VortexDisposition;
  }): void {
    // The connection attrs are recorded only when Vortex is installed: its
    // context augmentation subfeature reads them back at runtime.
    const attrs = {
      projectKey: projectKey ?? null,
      repoRoot: projectRoot,
      ...(vortexDisposition === 'install'
        ? { orgKey: auth.orgKey ?? null, scaEnabled: false, serverUrl: auth.serverUrl }
        : {}),
    };

    expect(installIntegrationSpy).toHaveBeenCalledTimes(1);
    expect(installIntegrationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: 'claude-code',
        auth,
        options: expect.objectContaining({
          projectRoot,
          globalSecretsHookExists,
          vortexDisposition,
        }),
        scope,
        targetRoot,
        attrs,
      }),
    );
  }
});
