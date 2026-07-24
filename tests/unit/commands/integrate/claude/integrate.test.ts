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

import * as token from '@/commands/_common/token.ts';
import * as contextAugmentation from '@/commands/integrate/_common/context-augmentation.ts';
import * as registry from '@/commands/integrate/_common/registry';
import { integrateClaude } from '@/commands/integrate/claude';
import * as hooks from '@/commands/integrate/claude/hooks.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import type { ResolvedAuth } from '@/core/host/auth-resolver.ts';
import * as gitWorktree from '@/core/host/git-worktree.ts';
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

function getPhaseItems(title: string): PhaseItem[] {
  const call = getMockUiCalls().find((c) => c.method === 'phase' && c.args[0] === title);
  return (call?.args[1] ?? []) as PhaseItem[];
}

describe('integrateCommand', () => {
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let hasSqaaEntitlementSpy: Mock<
    Extract<(typeof SonarQubeClient.prototype)['hasSqaaEntitlement'], (...args: any[]) => any>
  >;
  let hasCagEntitlementSpy: Mock<
    Extract<(typeof SonarQubeClient.prototype)['hasCagEntitlement'], (...args: any[]) => any>
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
  let resolveContextAugmentationSetupSpy: Mock<
    Extract<
      (typeof contextAugmentation)['resolveContextAugmentationSetup'],
      (...args: any[]) => any
    >
  >;
  let resolveRecordedRepoRootSpy: Mock<
    Extract<(typeof gitWorktree)['resolveRecordedRepoRoot'], (...args: any[]) => any>
  >;

  beforeEach(() => {
    setMockUi(true);

    hasSqaaEntitlementSpy = spyOn(SonarQubeClient.prototype, 'hasSqaaEntitlement');
    hasSqaaEntitlementSpy.mockResolvedValue('not_enabled');
    hasCagEntitlementSpy = spyOn(SonarQubeClient.prototype, 'hasCagEntitlement');
    hasCagEntitlementSpy.mockResolvedValue('entitled');
    resolveContextAugmentationSetupSpy = spyOn(
      contextAugmentation,
      'resolveContextAugmentationSetup',
    ).mockResolvedValue(null);
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
    hasSqaaEntitlementSpy.mockRestore();
    hasCagEntitlementSpy.mockRestore();
    checkTokenStatusSpy.mockRestore();
    checkComponentSpy.mockRestore();
    checkOrganizationSpy.mockRestore();
    discoverProjectSpy.mockRestore();
    installIntegrationSpy.mockRestore();
    detectGlobalSecretsHookSpy.mockRestore();
    resolveContextAugmentationSetupSpy.mockRestore();
    resolveRecordedRepoRootSpy.mockRestore();
  });

  it('shows intro message', async () => {
    await integrateClaude({}, SERVER_AUTH);

    const introText = getMockUiCalls().find(
      (c) =>
        c.method === 'intro' && String(c.args[0]) === 'SonarQube Integration Setup for Claude Code',
    );
    expect(introText).toBeDefined();
  });

  it('shows discovering project spinner', async () => {
    await integrateClaude({}, SERVER_AUTH);

    expect(
      getMockUiCalls().some(
        (c) => c.method === 'spinner' && String(c.args[0]) === 'Discovering project...',
      ),
    ).toBe(true);
  });

  it('shows Connection and Project setup summary sections', async () => {
    await integrateClaude({}, CLOUD_AUTH);

    expect(getPhaseItems('Connection').some((i) => i.text === 'Server')).toBe(true);
    expect(getPhaseItems('Connection').some((i) => i.text === 'Organization')).toBe(true);
    expect(
      getPhaseItems('Connection').some((i) => i.text === 'Token' && i.detail === 'valid'),
    ).toBe(true);
    expect(getPhaseItems('Project').some((i) => i.text === 'Root')).toBe(true);
  });

  it('validates token against the auth server URL', async () => {
    await integrateClaude({}, SERVER_AUTH);

    expect(checkTokenStatusSpy).toHaveBeenCalledWith(SERVER_AUTH.serverUrl, SERVER_AUTH.token);
  });

  it('shows warning when resolved server does not match discovered server', async () => {
    mockDiscoveredProject({ serverUrl: 'https://example-sonarqube.com' });

    await integrateClaude({}, CLOUD_AUTH);

    const warnText = getMockUiCalls().find(
      (c) => c.method === 'warn' && String(c.args[0]).includes('Server URL mismatch'),
    );
    expect(warnText).toBeDefined();
  });

  it('shows warning when resolved organization does not match discovered organization', async () => {
    mockDiscoveredProject({ organization: 'an-org' });

    await integrateClaude({}, CLOUD_AUTH);

    const warnText = getMockUiCalls().find(
      (c) => c.method === 'warn' && String(c.args[0]).includes('organization mismatch'),
    );
    expect(warnText).toBeDefined();
  });

  it('validates organization is provided when server is SonarQube Cloud', () => {
    mockDiscoveredProject({});
    const cloudAuthNoOrg: ResolvedAuth = {
      token: 'test-token',
      serverUrl: 'https://sonarcloud.io',
      connectionType: 'cloud',
    };

    expect(integrateClaude({}, cloudAuthNoOrg)).rejects.toThrow(CommandFailedError);
  });

  it('shows config source from discovered files', async () => {
    mockDiscoveredProject({
      projectKey: 'my-project',
      configSources: ['sonar-project.properties'],
    });

    await integrateClaude({}, SERVER_AUTH);

    const configSource = getPhaseItems('Project').find((i) => i.text === 'Config source');
    expect(configSource?.status).toBe('done');
    expect(configSource?.detail).toBe('sonar-project.properties');
  });

  it('shows config source as --project when the CLI flag overrides the key', async () => {
    mockDiscoveredProject({
      projectKey: 'discovered-key',
      configSources: ['sonar-project.properties'],
    });

    await integrateClaude({ project: 'cli-key' }, SERVER_AUTH);

    const configSource = getPhaseItems('Project').find((i) => i.text === 'Config source');
    expect(configSource?.status).toBe('info');
    expect(configSource?.detail).toBe('--project');
    expect(getPhaseItems('Project').find((i) => i.text === 'Key')?.detail).toBe('cli-key');
  });

  it('shows config source as none detected when no config file contributed', async () => {
    await integrateClaude({}, SERVER_AUTH);

    const configSource = getPhaseItems('Project').find((i) => i.text === 'Config source');
    expect(configSource?.status).toBe('warn');
    expect(configSource?.detail).toBe('none detected');
  });

  it('project key defaults to discovered project key', async () => {
    mockDiscoveredProject({ projectKey: 'project' });

    await integrateClaude({}, SERVER_AUTH);

    expect(getPhaseItems('Project').find((i) => i.text === 'Key')?.detail).toBe('project');
  });

  it('project key overrides discovered project key', async () => {
    mockDiscoveredProject({ projectKey: 'project' });

    await integrateClaude({ project: 'override-project' }, SERVER_AUTH);

    expect(getPhaseItems('Project').find((i) => i.text === 'Key')?.detail).toBe('override-project');
  });

  it('aborts when token is invalid', () => {
    checkTokenStatusSpy.mockResolvedValue({ status: 'invalid' });

    expect(integrateClaude({}, SERVER_AUTH)).rejects.toThrow('Token is invalid.');
    expect(installIntegrationSpy).not.toHaveBeenCalled();
  });

  it('aborts when server is unreachable', () => {
    checkTokenStatusSpy.mockResolvedValue({ status: 'unreachable' });

    expect(integrateClaude({}, SERVER_AUTH)).rejects.toThrow('Server is unreachable.');
    expect(installIntegrationSpy).not.toHaveBeenCalled();
  });

  it('checks SQAA entitlement', async () => {
    hasSqaaEntitlementSpy.mockResolvedValue('enabled');

    await integrateClaude({}, CLOUD_AUTH);

    expect(hasSqaaEntitlementSpy).toHaveBeenCalledTimes(1);
  });

  it('installs Context Augmentation through the declarative installer in a single call', async () => {
    mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
    resolveContextAugmentationSetupSpy.mockResolvedValue({ scaEnabled: true });

    await integrateClaude({}, CLOUD_AUTH);

    expect(installIntegrationSpy).toHaveBeenCalledTimes(1);
    expect(installIntegrationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: 'claude-code',
        auth: CLOUD_AUTH,
        options: expect.objectContaining({
          projectRoot: '/project/root',
          globalSecretsHookExists: false,
          installSqaaHook: false,
          installContextAugmentation: true,
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

  it('rethrows CAG installation failures', async () => {
    mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
    resolveContextAugmentationSetupSpy.mockResolvedValue({ scaEnabled: false });
    installIntegrationSpy.mockRejectedValueOnce(new Error('print failed'));

    let thrown: unknown;
    try {
      await integrateClaude({}, CLOUD_AUTH);
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
    mockSqaaEntitlement(true);

    await integrateClaude({}, CLOUD_AUTH);

    assertMigrationAndHookInstallationRan('a-project', '/project/root', undefined, false, true);
  });

  it('runs migration and installs hooks when global option is set', async () => {
    mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
    mockSqaaEntitlement(true);

    await integrateClaude({ global: true }, CLOUD_AUTH);

    // SQAA is project-scoped, so a global install never enables it even when the
    // org is entitled — sqaaEnabled flows through as false.
    assertMigrationAndHookInstallationRan('a-project', '/project/root', homedir(), true, false);
  });

  it('still installs when organization access check fails in the summary', async () => {
    mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
    mockSqaaEntitlement(true);
    checkOrganizationSpy.mockResolvedValue(false);

    await integrateClaude({}, CLOUD_AUTH);

    assertMigrationAndHookInstallationRan('a-project', '/project/root', undefined, false, true);
  });

  it('runs migration and installs hooks when project key is missing', async () => {
    mockDiscoveredProject({ rootDir: '/projectB/root' });
    mockSqaaEntitlement(false);

    await integrateClaude({}, CLOUD_AUTH);

    assertMigrationAndHookInstallationRan(undefined, '/projectB/root', undefined, false, false);
  });

  it('aborts integration when sonar-secrets installation fails', async () => {
    installIntegrationSpy.mockRejectedValueOnce(new Error('Network error'));

    let error: unknown;
    try {
      await integrateClaude({}, SERVER_AUTH);
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

      await integrateClaude({}, SERVER_AUTH);

      expectClaudeInstallCall({
        targetRoot: '/project/root',
        scope: 'project',
        auth: SERVER_AUTH,
        projectRoot: '/project/root',
        projectKey: 'a-project',
        globalSecretsHookExists: true,
        installSqaaHook: false,
        installSqaaInstructions: false,
      });
    });

    it('still installs the project-scoped sonar-sqaa hook when SQAA is entitled', async () => {
      mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
      mockSqaaEntitlement(true);

      await integrateClaude({}, CLOUD_AUTH);

      expectClaudeInstallCall({
        targetRoot: '/project/root',
        scope: 'project',
        auth: CLOUD_AUTH,
        projectRoot: '/project/root',
        projectKey: 'a-project',
        globalSecretsHookExists: true,
        installSqaaHook: true,
        installSqaaInstructions: true,
      });
    });
  });

  describe('when no global Claude hook is configured', () => {
    beforeEach(() => {
      detectGlobalSecretsHookSpy.mockResolvedValue(undefined);
    });

    it('falls back to a project-level install (does not skip secrets hooks)', async () => {
      mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });

      await integrateClaude({}, SERVER_AUTH);

      expectClaudeInstallCall({
        targetRoot: '/project/root',
        scope: 'project',
        auth: SERVER_AUTH,
        projectRoot: '/project/root',
        projectKey: 'a-project',
        globalSecretsHookExists: false,
        installSqaaHook: false,
        installSqaaInstructions: false,
      });
    });
  });

  describe('when -g (global) is used', () => {
    it('does not probe for a pre-existing global hook', async () => {
      await integrateClaude({ global: true }, SERVER_AUTH);

      expect(detectGlobalSecretsHookSpy).not.toHaveBeenCalled();
    });

    it('does not print the "already configured globally" skip notice (no probe is run)', async () => {
      await integrateClaude({ global: true }, SERVER_AUTH);

      const skipNotice = getMockUiCalls().find(
        (c) =>
          c.method === 'info' && String(c.args[0]).includes('already configured for SonarQube'),
      );
      expect(skipNotice).toBeUndefined();
    });

    it('skips the SQAA hook (and warns) even when the org is entitled', async () => {
      mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
      mockSqaaEntitlement(true);

      await integrateClaude({ global: true }, CLOUD_AUTH);

      // SQAA is never installed on a global run, and the install/state
      // paths all see sqaaEnabled = false.
      expectClaudeInstallCall({
        targetRoot: homedir(),
        scope: 'global',
        auth: CLOUD_AUTH,
        projectRoot: '/project/root',
        projectKey: 'a-project',
        globalSecretsHookExists: false,
        installSqaaHook: false,
        installSqaaInstructions: false,
      });

      const warnNotice = getMockUiCalls().find(
        (c) => c.method === 'warn' && String(c.args[0]).includes('not supported with --global'),
      );
      expect(warnNotice).toBeDefined();
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

  function mockSqaaEntitlement(hasEntitlement: boolean) {
    hasSqaaEntitlementSpy.mockResolvedValue(hasEntitlement ? 'enabled' : 'not_enabled');
  }

  function assertMigrationAndHookInstallationRan(
    projectKey: string | undefined,
    projectRootDir: string,
    globalDir: string | undefined,
    isGlobal: boolean,
    sqaaEnabled: boolean,
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
      installSqaaHook: sqaaEnabled && projectKey !== undefined,
      installSqaaInstructions: sqaaEnabled && projectKey !== undefined,
    });
  }

  function expectClaudeInstallCall({
    targetRoot,
    scope,
    auth,
    projectRoot,
    projectKey,
    globalSecretsHookExists,
    installSqaaHook,
    installSqaaInstructions,
  }: {
    targetRoot: string;
    scope: 'global' | 'project';
    auth: ResolvedAuth;
    projectRoot: string;
    projectKey?: string;
    globalSecretsHookExists: boolean;
    installSqaaHook: boolean;
    installSqaaInstructions: boolean;
  }): void {
    const attrs = {
      projectKey: projectKey ?? null,
      repoRoot: projectRoot,
    };

    expect(installIntegrationSpy).toHaveBeenCalledTimes(1);
    expect(installIntegrationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: 'claude-code',
        auth,
        options: expect.objectContaining({
          projectRoot,
          globalSecretsHookExists,
          installSqaaHook,
          installSqaaInstructions,
        }),
        scope,
        targetRoot,
        attrs,
      }),
    );
  }
});
