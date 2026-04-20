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

import { CommandFailedError } from '../../../../../../src/cli/commands/_common/error';
import * as installSecrets from '../../../../../../src/cli/commands/_common/install/secrets';
import { integrateClaude } from '../../../../../../src/cli/commands/integrate/claude';
import * as health from '../../../../../../src/cli/commands/integrate/claude/health';
import { HealthCheckResult } from '../../../../../../src/cli/commands/integrate/claude/health';
import * as hooks from '../../../../../../src/cli/commands/integrate/claude/hooks';
import * as mcp from '../../../../../../src/cli/commands/integrate/claude/mcp';
import * as repair from '../../../../../../src/cli/commands/integrate/claude/repair';
import * as state from '../../../../../../src/cli/commands/integrate/claude/state';
import type { ResolvedAuth } from '../../../../../../src/lib/auth-resolver';
import * as authResolver from '../../../../../../src/lib/auth-resolver';
import * as migration from '../../../../../../src/lib/migration';
import type { DiscoveredProject } from '../../../../../../src/lib/project-workspace';
import * as discovery from '../../../../../../src/lib/project-workspace';
import { getDefaultState } from '../../../../../../src/lib/state';
import * as stateManager from '../../../../../../src/lib/state-manager';
import { SonarQubeClient } from '../../../../../../src/sonarqube/client';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../../../src/ui';

const CLEAN_HEALTH: HealthCheckResult = {
  tokenValid: true,
  serverAvailable: true,
  projectAccessible: true,
  organizationAccessible: true,
  qualityProfilesAccessible: true,
  hooksInstalled: true,
  errors: [],
};

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

describe('integrateCommand', () => {
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let hasSqaaEntitlementSpy: Mock<
    Extract<(typeof SonarQubeClient.prototype)['hasSqaaEntitlement'], (...args: any[]) => any>
  >;
  let isEnvBasedAuthSpy: Mock<
    Extract<(typeof authResolver)['isEnvBasedAuth'], (...args: any[]) => any>
  >;
  let runHealthChecksSpy: Mock<
    Extract<(typeof health)['runHealthChecks'], (...args: any[]) => any>
  >;
  let discoverProjectSpy: Mock<
    Extract<(typeof discovery)['discoverProject'], (...args: any[]) => any>
  >;
  let repairTokenSpy: Mock<Extract<(typeof repair)['repairToken'], (...args: any[]) => any>>;
  let installHooksSpy: Mock<Extract<(typeof hooks)['installHooks'], (...args: any[]) => any>>;
  let detectSecretsHookSpy: Mock<
    Extract<(typeof hooks)['detectSecretsHook'], (...args: any[]) => any>
  >;
  let runMigrationsSpy: Mock<Extract<(typeof migration)['runMigrations'], (...args: any[]) => any>>;
  let updateStateAfterConfigurationSpy: Mock<
    Extract<(typeof state)['updateStateAfterConfiguration'], (...args: any[]) => any>
  >;
  let resolveSecretsBinarySpy: Mock<
    Extract<(typeof installSecrets)['resolveSecretsBinary'], (...args: any[]) => any>
  >;
  let setupMcpServerSpy: Mock<Extract<(typeof mcp)['setupMcpServer'], (...args: any[]) => any>>;

  beforeEach(() => {
    setMockUi(true);

    hasSqaaEntitlementSpy = spyOn(SonarQubeClient.prototype, 'hasSqaaEntitlement');
    hasSqaaEntitlementSpy.mockResolvedValue(false);
    setupMcpServerSpy = spyOn(mcp, 'setupMcpServer').mockResolvedValue(undefined);

    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});

    isEnvBasedAuthSpy = spyOn(authResolver, 'isEnvBasedAuth');
    runHealthChecksSpy = spyOn(health, 'runHealthChecks');
    discoverProjectSpy = spyOn(discovery, 'discoverProject');
    repairTokenSpy = spyOn(repair, 'repairToken');
    installHooksSpy = spyOn(hooks, 'installHooks');
    detectSecretsHookSpy = spyOn(hooks, 'detectSecretsHook').mockResolvedValue({ kind: 'absent' });
    runMigrationsSpy = spyOn(migration, 'runMigrations');
    updateStateAfterConfigurationSpy = spyOn(state, 'updateStateAfterConfiguration');

    resolveSecretsBinarySpy = spyOn(installSecrets, 'resolveSecretsBinary').mockResolvedValue({
      binaryPath: '/fake/path/sonar-secrets',
      freshlyInstalled: false,
    });

    mockDiscoveredProject({}); // Default mock to prevent tests from reading the real filesystem. Individual tests are overriding this with specific project data as needed.
    mockHealthCheck(); // Default mock to healthy checks. Individual tests are overriding this with specific health data as needed.
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    hasSqaaEntitlementSpy.mockRestore();
    isEnvBasedAuthSpy.mockRestore();
    runHealthChecksSpy.mockRestore();
    discoverProjectSpy.mockRestore();
    repairTokenSpy.mockRestore();
    installHooksSpy.mockRestore();
    detectSecretsHookSpy.mockRestore();
    runMigrationsSpy.mockRestore();
    updateStateAfterConfigurationSpy.mockRestore();
    resolveSecretsBinarySpy.mockRestore();
    setupMcpServerSpy.mockRestore();
  });

  it('shows intro message', async () => {
    await integrateClaude({}, SERVER_AUTH);

    const introText = getMockUiCalls().find(
      (c) => c.method === 'intro' && String(c.args[0]) === 'SonarQube Integration Setup for Claude',
    );
    expect(introText).toBeDefined();
  });

  it('shows phase 1 text', async () => {
    await integrateClaude({}, SERVER_AUTH);

    const phaseText = getMockUiCalls().find(
      (c) => c.method === 'text' && String(c.args[0]) === 'Phase 1/3: Discovery & Validation',
    );
    expect(phaseText).toBeDefined();
  });

  it('uses auth server for health checks', async () => {
    mockDiscoveredProject({});

    await integrateClaude({}, SERVER_AUTH);

    const lastHealthCheckCall = runHealthChecksSpy.mock.calls.at(-1)!;
    expect(lastHealthCheckCall[0]).toBe(SERVER_AUTH.serverUrl);
  });

  it('auth server overrides discovered server', async () => {
    mockDiscoveredProject({ serverUrl: 'https://example-sonarqube.com' });

    await integrateClaude({}, SERVER_AUTH);

    const lastHealthCheckCall = runHealthChecksSpy.mock.calls.at(-1)!;
    expect(lastHealthCheckCall[0]).toBe(SERVER_AUTH.serverUrl);
  });

  it('shows warning when resolved server does not match discovered server', async () => {
    mockDiscoveredProject({ serverUrl: 'https://example-sonarqube.com' });

    await integrateClaude({}, CLOUD_AUTH);

    const warnText = getMockUiCalls().find(
      (c) => c.method === 'warn' && String(c.args[0]).includes('Server URL mismatch'),
    );
    expect(warnText).toBeDefined();
  });

  it('auth organization overrides discovered organization', async () => {
    mockDiscoveredProject({ organization: 'an-org' });

    await integrateClaude({}, CLOUD_AUTH);

    const lastHealthCheckCall = runHealthChecksSpy.mock.calls.at(-1)!;
    expect(lastHealthCheckCall[4]).toBe(CLOUD_AUTH.orgKey);
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

  it('project key defaults to discovered project key', async () => {
    mockDiscoveredProject({ projectKey: 'project' });

    await integrateClaude({}, SERVER_AUTH);

    const lastHealthCheckCall = runHealthChecksSpy.mock.calls.at(-1)!;
    expect(lastHealthCheckCall[2]).toBe('project');
  });

  it('project key overrides discovered project key', async () => {
    mockDiscoveredProject({ projectKey: 'project' });

    await integrateClaude({ project: 'override-project' }, SERVER_AUTH);

    const lastHealthCheckCall = runHealthChecksSpy.mock.calls.at(-1)!;
    expect(lastHealthCheckCall[2]).toBe('override-project');
  });

  it('shows phase 2 text', async () => {
    await integrateClaude({}, SERVER_AUTH);

    const phaseText = getMockUiCalls().find(
      (c) => c.method === 'text' && String(c.args[0]) === 'Phase 2/3: Health Check & Repair',
    );
    expect(phaseText).toBeDefined();
  });

  it('shows success message on heath check success', async () => {
    await integrateClaude({}, SERVER_AUTH);

    const successText = getMockUiCalls().find(
      (c) =>
        c.method === 'success' &&
        String(c.args[0]).includes('All checks passed! Configuration is healthy.'),
    );
    expect(successText).toBeDefined();
  });

  it('shows warning message when heath check fails', async () => {
    repairTokenSpy.mockResolvedValue('repaired-token');
    mockHealthCheckOnce({
      tokenValid: false,
      errors: ['HealthError1', 'HealthError2', 'HealthError3'],
    });
    mockHealthCheck();

    await integrateClaude({}, SERVER_AUTH);

    const warnText = getMockUiCalls().find(
      (c) => c.method === 'warn' && String(c.args[0]).includes('Found 3 issue(s):'),
    );
    expect(warnText).toBeDefined();
  });

  it('shows heath check failures in detail', async () => {
    repairTokenSpy.mockResolvedValue('repaired-token');
    mockHealthCheckOnce({
      tokenValid: false,
      errors: ['HealthError1', 'HealthError2', 'HealthError3'],
    });
    mockHealthCheck();

    await integrateClaude({}, SERVER_AUTH);

    const healthText = getMockUiCalls()
      .filter((c) => c.method === 'text' && String(c.args[0]).includes('HealthError'))
      .map((c) => String(c.args[0]));
    expect(healthText).toBeArrayOfSize(3);
    expect(healthText).toEqual(['  - HealthError1', '  - HealthError2', '  - HealthError3']);
  });

  it('attempts repair when health check shows token is invalid', async () => {
    repairTokenSpy.mockResolvedValue('repaired-token');
    mockHealthCheckOnce({ tokenValid: false, errors: ['Token is invalid'] });
    mockHealthCheck();

    await integrateClaude({}, CLOUD_AUTH);

    expect(repairTokenSpy).toHaveBeenCalledTimes(1);
    expect(repairTokenSpy).toHaveBeenCalledWith(CLOUD_AUTH.serverUrl, CLOUD_AUTH.orgKey);
  });

  it('attempts repair when health fails for token', async () => {
    repairTokenSpy.mockResolvedValue('repaired-token');
    mockHealthCheckOnce({ tokenValid: false, errors: ['Token is invalid'] });
    mockHealthCheck();

    await integrateClaude({}, SERVER_AUTH);

    expect(repairTokenSpy).toHaveBeenCalledTimes(1);
    expect(repairTokenSpy).toHaveBeenCalledWith(SERVER_AUTH.serverUrl, undefined);
  });

  it('does not repair token when non-interactive option', async () => {
    repairTokenSpy.mockResolvedValue('repaired-token');
    runHealthChecksSpy.mockResolvedValue({
      ...CLEAN_HEALTH,
      tokenValid: false,
      errors: ['Token is invalid'],
    });

    await integrateClaude({ nonInteractive: true }, CLOUD_AUTH);

    expect(repairTokenSpy).not.toBeCalled();
  });

  it('does not repair token when auth is env-based', async () => {
    repairTokenSpy.mockResolvedValue('repaired-token');
    runHealthChecksSpy.mockResolvedValue({
      ...CLEAN_HEALTH,
      tokenValid: false,
      errors: ['Token is invalid'],
    });
    isEnvBasedAuthSpy.mockReturnValue(true);

    await integrateClaude({}, CLOUD_AUTH);

    expect(repairTokenSpy).not.toBeCalled();
  });

  it('checks SQAA entitlement', async () => {
    hasSqaaEntitlementSpy.mockResolvedValue(true);

    await integrateClaude({}, CLOUD_AUTH);

    expect(hasSqaaEntitlementSpy).toHaveBeenCalledTimes(1);
  });

  it('runs migration, installs hooks and updates state when health check succeeds', async () => {
    mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
    mockSqaaEntitlement(true);

    await integrateClaude({}, CLOUD_AUTH);

    assertMigrationHookInstallationAndStateUpdateRan(
      'a-project',
      '/project/root',
      undefined,
      false,
      true,
    );
  });

  it('runs migration, installs hooks and updates state when global option and health check succeeds', async () => {
    mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
    mockSqaaEntitlement(true);

    await integrateClaude({ global: true }, CLOUD_AUTH);

    assertMigrationHookInstallationAndStateUpdateRan(
      'a-project',
      '/project/root',
      homedir(),
      true,
      true,
    );
  });

  it('runs migration, installs hooks and updates state when health check fails', async () => {
    mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
    mockSqaaEntitlement(true);
    mockHealthCheck({ organizationAccessible: false, errors: ['Organization not accessible'] });

    await integrateClaude({}, CLOUD_AUTH);

    assertMigrationHookInstallationAndStateUpdateRan(
      'a-project',
      '/project/root',
      undefined,
      false,
      true,
    );
  });

  it('runs migration, installs hooks and updates state when project key is missing', async () => {
    mockDiscoveredProject({ rootDir: '/projectB/root' });
    mockSqaaEntitlement(false);

    await integrateClaude({}, CLOUD_AUTH);

    assertMigrationHookInstallationAndStateUpdateRan(
      undefined,
      '/projectB/root',
      undefined,
      false,
      false,
    );
  });

  it('shows phase 3 text', async () => {
    await integrateClaude({}, SERVER_AUTH);

    const phaseText = getMockUiCalls().find(
      (c) => c.method === 'text' && String(c.args[0]) === 'Phase 3/3: Final Verification',
    );
    expect(phaseText).toBeDefined();
  });

  it('shows outro message', async () => {
    await integrateClaude({}, SERVER_AUTH);

    const phaseText = getMockUiCalls().find(
      (c) => c.method === 'outro' && String(c.args[0]) === 'Setup complete!',
    );
    expect(phaseText).toBeDefined();
  });

  it('shows warning message when final heath check fails', async () => {
    repairTokenSpy.mockResolvedValue('repaired-token');
    mockHealthCheckOnce({ errors: ['HealthError1', 'HealthError2', 'HealthError3'] });
    mockHealthCheck({ errors: ['RemainingHealthError1', 'RemainingHealthError3'] });

    await integrateClaude({}, SERVER_AUTH);

    const warnText = getMockUiCalls().find(
      (c) => c.method === 'warn' && String(c.args[0]).includes('Some issues remain:'),
    );
    expect(warnText).toBeDefined();
  });

  it('shows final heath check failures in detail', async () => {
    repairTokenSpy.mockResolvedValue('repaired-token');
    mockHealthCheckOnce({ errors: ['HealthError1', 'HealthError2', 'HealthError3'] });
    mockHealthCheck({ errors: ['RemainingHealthError1', 'RemainingHealthError3'] });

    await integrateClaude({}, SERVER_AUTH);

    const healthText = getMockUiCalls()
      .filter((c) => c.method === 'text' && String(c.args[0]).includes('RemainingHealthError'))
      .map((c) => String(c.args[0]));
    expect(healthText).toBeArrayOfSize(2);
    expect(healthText).toEqual(['  - RemainingHealthError1', '  - RemainingHealthError3']);
  });

  it('shows secrets hook example when hooks installed', async () => {
    await integrateClaude({}, SERVER_AUTH);

    const infoText = getMockUiCalls().find(
      (c) =>
        c.method === 'info' &&
        String(c.args[0]) === 'See it in action - paste this into Claude Code:',
    );
    expect(infoText).toBeDefined();
    const exampleText = getMockUiCalls().find(
      (c) =>
        c.method === 'note' &&
        String(c.args[0]).search(/Can you push a commit using my token \w+/) > -1,
    );
    expect(exampleText).toBeDefined();
  });

  it('aborts integration when sonar-secrets installation fails', async () => {
    resolveSecretsBinarySpy.mockRejectedValue(new Error('Network error'));

    let error: unknown;
    try {
      await integrateClaude({}, SERVER_AUTH);
    } catch (err) {
      error = err;
    }

    expect((error as Error).message).toBe('Network error');
    expect(installHooksSpy).not.toHaveBeenCalled();
  });

  describe('when a global Claude hook is already configured', () => {
    const GLOBAL_HOOK_PATH = `${homedir()}/.claude/hooks/sonar-secrets`;

    beforeEach(() => {
      detectSecretsHookSpy.mockResolvedValue({ kind: 'installed', hookDir: GLOBAL_HOOK_PATH });
    });

    it('shows the "already configured globally — project-level skipped" notice', async () => {
      await integrateClaude({}, SERVER_AUTH);

      const notice = getMockUiCalls().find(
        (c) =>
          c.method === 'info' &&
          String(c.args[0]).includes(
            'A global secrets scanning hook is already configured for SonarQube. To avoid duplicate execution, project-level secrets hooks were skipped.',
          ),
      );
      expect(notice).toBeDefined();
    });

    it('prints the "configured. Secrets scanning will use the existing global hook at <path>" success message', async () => {
      await integrateClaude({}, SERVER_AUTH);

      const successMsg = getMockUiCalls().find(
        (c) =>
          c.method === 'success' &&
          String(c.args[0]) ===
            `Claude integration configured. Secrets scanning will use the existing global hook at: ${GLOBAL_HOOK_PATH}`,
      );
      expect(successMsg).toBeDefined();
    });

    it('does not print the "configured at the project level" success message', async () => {
      await integrateClaude({}, SERVER_AUTH);

      const projectSuccess = getMockUiCalls().find(
        (c) =>
          c.method === 'success' &&
          String(c.args[0]).includes(
            'Claude integration successfully configured at the project level',
          ),
      );
      expect(projectSuccess).toBeUndefined();
    });

    it('forwards skipSecretsHooks: true to installHooks, runMigrations and updateStateAfterConfiguration', async () => {
      mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });

      await integrateClaude({}, SERVER_AUTH);

      expect(installHooksSpy).toHaveBeenCalledWith('/project/root', undefined, false, 'a-project', {
        skipSecretsHooks: true,
      });
      expect(runMigrationsSpy).toHaveBeenCalledWith(
        '/project/root',
        undefined,
        false,
        'a-project',
        { skipSecretsHooks: true },
      );
      expect(updateStateAfterConfigurationSpy).toHaveBeenCalledWith(
        expect.anything(),
        '/project/root',
        false,
        false,
        { skipSecretsHooks: true },
      );
    });

    it('still installs the project-scoped sonar-sqaa hook when SQAA is entitled', async () => {
      mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
      mockSqaaEntitlement(true);

      await integrateClaude({}, CLOUD_AUTH);

      expect(installHooksSpy).toHaveBeenCalledWith('/project/root', undefined, true, 'a-project', {
        skipSecretsHooks: true,
      });
    });

    it('runs health checks against the global hooks root rather than the project root', async () => {
      mockDiscoveredProject({ rootDir: '/project/root' });

      await integrateClaude({}, SERVER_AUTH);

      const healthCall = runHealthChecksSpy.mock.calls.at(-1)!;
      expect(healthCall[3]).toBe(homedir());
    });

    it('does not print the "no global hook found" notice', async () => {
      await integrateClaude({}, SERVER_AUTH);

      const fallback = getMockUiCalls().find(
        (c) => c.method === 'text' && String(c.args[0]).includes('No global Claude hook was found'),
      );
      expect(fallback).toBeUndefined();
    });
  });

  describe('when no global Claude hook is configured', () => {
    it('announces that configuration proceeds at project level', async () => {
      detectSecretsHookSpy.mockResolvedValue({ kind: 'absent' });

      await integrateClaude({}, SERVER_AUTH);

      const notice = getMockUiCalls().find(
        (c) =>
          c.method === 'text' &&
          String(c.args[0]) ===
            'No global Claude hook was found. Configuring SonarQube for this project only.',
      );
      expect(notice).toBeDefined();
    });

    it('prints the "configured at the project level" success on completion', async () => {
      detectSecretsHookSpy.mockResolvedValue({ kind: 'absent' });

      await integrateClaude({}, SERVER_AUTH);

      const projectSuccess = getMockUiCalls().find(
        (c) =>
          c.method === 'success' &&
          String(c.args[0]) === 'Claude integration successfully configured at the project level',
      );
      expect(projectSuccess).toBeDefined();
    });
  });

  describe('when the global Claude hook is in a broken/orphaned state', () => {
    const ORPHAN_HOOK_DIR = `${homedir()}/.claude/hooks/sonar-secrets`;

    beforeEach(() => {
      detectSecretsHookSpy.mockResolvedValue({
        kind: 'orphaned',
        hookDir: ORPHAN_HOOK_DIR,
      });
    });

    it('warns the user with the exact "source files are missing" message including the path', async () => {
      await integrateClaude({}, SERVER_AUTH);

      const warning = getMockUiCalls().find(
        (c) =>
          c.method === 'warn' &&
          String(c.args[0]) ===
            `WARNING: Global hook configuration detected, but the source files are missing at ${ORPHAN_HOOK_DIR}. Falling back to local project installation`,
      );
      expect(warning).toBeDefined();
    });

    it('falls back to a project-level install (does not skip secrets hooks)', async () => {
      mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });

      await integrateClaude({}, SERVER_AUTH);

      expect(installHooksSpy).toHaveBeenCalledWith('/project/root', undefined, false, 'a-project', {
        skipSecretsHooks: false,
      });
    });

    it('runs health checks against the project root, not the global root', async () => {
      mockDiscoveredProject({ rootDir: '/project/root' });

      await integrateClaude({}, SERVER_AUTH);

      const healthCall = runHealthChecksSpy.mock.calls.at(-1)!;
      expect(healthCall[3]).toBe('/project/root');
    });

    it('still prints the project-level success message on completion', async () => {
      await integrateClaude({}, SERVER_AUTH);

      const projectSuccess = getMockUiCalls().find(
        (c) =>
          c.method === 'success' &&
          String(c.args[0]) === 'Claude integration successfully configured at the project level',
      );
      expect(projectSuccess).toBeDefined();
    });
  });

  describe('when -g (global) is used', () => {
    it('does not probe for a pre-existing global hook', async () => {
      await integrateClaude({ global: true }, SERVER_AUTH);

      expect(detectSecretsHookSpy).not.toHaveBeenCalled();
    });

    it('prints the "configured globally" success on completion', async () => {
      await integrateClaude({ global: true }, SERVER_AUTH);

      const globalSuccess = getMockUiCalls().find(
        (c) =>
          c.method === 'success' &&
          String(c.args[0]) === 'Claude integration successfully configured globally',
      );
      expect(globalSuccess).toBeDefined();
    });

    it('does not print either scope notice (the "no global" text is for the project-level path only)', async () => {
      await integrateClaude({ global: true }, SERVER_AUTH);

      const projectNotice = getMockUiCalls().find(
        (c) => c.method === 'text' && String(c.args[0]).includes('No global Claude hook was found'),
      );
      const skipNotice = getMockUiCalls().find(
        (c) =>
          c.method === 'info' && String(c.args[0]).includes('already configured for SonarQube'),
      );
      expect(projectNotice).toBeUndefined();
      expect(skipNotice).toBeUndefined();
    });
  });

  it('skips secrets hook example when hooks not installed', async () => {
    mockHealthCheck({ hooksInstalled: false });

    await integrateClaude({}, SERVER_AUTH);

    const infoText = getMockUiCalls().find(
      (c) =>
        c.method === 'info' &&
        String(c.args[0]) === 'See it in action - paste this into Claude Code:',
    );
    expect(infoText).not.toBeDefined();
    const exampleText = getMockUiCalls().find(
      (c) =>
        c.method === 'note' &&
        String(c.args[0]).search(/Can you push a commit using my token \w+/) > -1,
    );
    expect(exampleText).not.toBeDefined();
  });

  function mockDiscoveredProject(project: Partial<DiscoveredProject>) {
    discoverProjectSpy.mockResolvedValue({
      rootDir: project.rootDir || process.cwd(),
      isGitRepo: project.isGitRepo ?? false,
      serverUrl: project.serverUrl,
      organization: project.organization,
      projectKey: project.projectKey,
    });
  }

  function mockHealthCheck(health?: Partial<HealthCheckResult>) {
    runHealthChecksSpy.mockResolvedValue({ ...CLEAN_HEALTH, ...health });
  }

  function mockHealthCheckOnce(health?: Partial<HealthCheckResult>) {
    runHealthChecksSpy.mockResolvedValueOnce({ ...CLEAN_HEALTH, ...health });
  }

  function mockSqaaEntitlement(hasEntitlement: boolean) {
    hasSqaaEntitlementSpy.mockResolvedValue(hasEntitlement);
  }

  function assertMigrationHookInstallationAndStateUpdateRan(
    projectKey: string | undefined,
    projectRootDir: string,
    globalDir: string | undefined,
    isGlobal: boolean,
    sqaaEnabled: boolean,
  ): void {
    const expectedOptions = { skipSecretsHooks: false };
    expect(runMigrationsSpy).toHaveBeenCalledTimes(1);
    expect(runMigrationsSpy).toHaveBeenCalledWith(
      projectRootDir,
      globalDir,
      sqaaEnabled,
      projectKey,
      expectedOptions,
    );
    expect(installHooksSpy).toHaveBeenCalledTimes(1);
    expect(installHooksSpy).toHaveBeenCalledWith(
      projectRootDir,
      globalDir,
      sqaaEnabled,
      projectKey,
      expectedOptions,
    );
    expect(updateStateAfterConfigurationSpy).toHaveBeenCalledTimes(1);
    expect(updateStateAfterConfigurationSpy).toHaveBeenCalledWith(
      expect.anything(),
      projectRootDir,
      isGlobal,
      sqaaEnabled,
      expectedOptions,
    );
  }
});
