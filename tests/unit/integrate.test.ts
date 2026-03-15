/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test';
import { homedir } from 'node:os';
import * as discovery from '../../src/cli/commands/_common/discovery';
import { DiscoveredProject } from '../../src/cli/commands/_common/discovery';
import { CommandFailedError } from '../../src/cli/commands/_common/error';
import { integrateClaude } from '../../src/cli/commands/integrate/claude';
import { HealthCheckResult } from '../../src/cli/commands/integrate/claude/health';
import * as health from '../../src/cli/commands/integrate/claude/health';
import * as hooks from '../../src/cli/commands/integrate/claude/hooks';
import * as repair from '../../src/cli/commands/integrate/claude/repair';
import * as state from '../../src/cli/commands/integrate/claude/state';
import * as authResolver from '../../src/lib/auth-resolver';
import { ResolvedAuth } from '../../src/lib/auth-resolver';
import * as migration from '../../src/lib/migration';
import { getDefaultState } from '../../src/lib/state';
import * as stateManager from '../../src/lib/state-manager';
import { SonarQubeClient } from '../../src/sonarqube/client';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../src/ui';

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
};

const CLOUD_AUTH: ResolvedAuth = {
  token: 'test-token',
  orgKey: 'cloud-org',
  serverUrl: 'https://sonarcloud.io',
};

describe('integrateCommand', () => {
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let hasA3sEntitlementSpy: Mock<
    Extract<(typeof SonarQubeClient.prototype)['hasA3sEntitlement'], (...args: any[]) => any>
  >;
  let resolveAuthSpy: Mock<Extract<(typeof authResolver)['resolveAuth'], (...args: any[]) => any>>;
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
  let runMigrationsSpy: Mock<Extract<(typeof migration)['runMigrations'], (...args: any[]) => any>>;
  let updateStateAfterConfigurationSpy: Mock<
    Extract<(typeof state)['updateStateAfterConfiguration'], (...args: any[]) => any>
  >;

  beforeEach(() => {
    setMockUi(true);

    hasA3sEntitlementSpy = spyOn(SonarQubeClient.prototype, 'hasA3sEntitlement');
    hasA3sEntitlementSpy.mockResolvedValue(false);

    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});

    resolveAuthSpy = spyOn(authResolver, 'resolveAuth');
    isEnvBasedAuthSpy = spyOn(authResolver, 'isEnvBasedAuth');
    runHealthChecksSpy = spyOn(health, 'runHealthChecks');
    discoverProjectSpy = spyOn(discovery, 'discoverProject');
    repairTokenSpy = spyOn(repair, 'repairToken');
    installHooksSpy = spyOn(hooks, 'installHooks');
    runMigrationsSpy = spyOn(migration, 'runMigrations');
    updateStateAfterConfigurationSpy = spyOn(state, 'updateStateAfterConfiguration');

    mockDiscoveredProject({}); // Default mock to prevent tests from reading the real filesystem. Individual tests are overriding this with specific project data as needed.
    mockHealthCheck(); // Default mock to healthy checks. Individual tests are overriding this with specific health data as needed.
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    hasA3sEntitlementSpy.mockRestore();
    resolveAuthSpy.mockRestore();
    isEnvBasedAuthSpy.mockRestore();
    runHealthChecksSpy.mockRestore();
    discoverProjectSpy.mockRestore();
    repairTokenSpy.mockRestore();
    installHooksSpy.mockRestore();
    runMigrationsSpy.mockRestore();
    updateStateAfterConfigurationSpy.mockRestore();
  });

  it('shows intro message', async () => {
    resolveAuthSpy.mockResolvedValue(SERVER_AUTH);

    await integrateClaude({});

    const introText = getMockUiCalls().find(
      (c) => c.method === 'intro' && String(c.args[0]) === 'SonarQube Integration Setup for Claude',
    );
    expect(introText).toBeDefined();
  });

  it('shows phase 1 text', async () => {
    resolveAuthSpy.mockResolvedValue(SERVER_AUTH);

    await integrateClaude({});

    const phaseText = getMockUiCalls().find(
      (c) => c.method === 'text' && String(c.args[0]) === 'Phase 1/3: Discovery & Validation',
    );
    expect(phaseText).toBeDefined();
  });

  it('server defaults to SonarQube Cloud EU when organization is provided but no server', async () => {
    mockNoAuth();
    mockDiscoveredProject({});

    await integrateClaude({ org: 'my-org' });

    const lastHealthCheckCall = runHealthChecksSpy.mock.calls.at(-1)!;
    expect(lastHealthCheckCall[0]).toBe('https://sonarcloud.io');
  });

  it('server option overrides default server', async () => {
    mockNoAuth();
    mockDiscoveredProject({});

    await integrateClaude({ server: 'https://example-sonarqube.com' });

    const lastHealthCheckCall = runHealthChecksSpy.mock.calls.at(-1)!;
    expect(lastHealthCheckCall[0]).toBe('https://example-sonarqube.com');
  });

  it('server option overrides discovered server', async () => {
    mockNoAuth();
    mockDiscoveredProject({ serverUrl: 'https://discovered-sonarqube.com' });

    await integrateClaude({ server: 'https://example-sonarqube.com' });

    const lastHealthCheckCall = runHealthChecksSpy.mock.calls.at(-1)!;
    expect(lastHealthCheckCall[0]).toBe('https://example-sonarqube.com');
  });

  it('server option overrides auth server', async () => {
    mockDiscoveredProject({ serverUrl: 'https://non-considered-sonarqube.com' });

    await integrateClaude({ server: 'https://example-sonarqube.com' });

    const resolveAuthCall = resolveAuthSpy.mock.calls.at(0) as Parameters<
      typeof authResolver.resolveAuth
    >;
    expect(resolveAuthCall[0].server).toBe('https://example-sonarqube.com');
  });

  it('auth server overrides discovered server', async () => {
    resolveAuthSpy.mockResolvedValue(SERVER_AUTH);
    mockDiscoveredProject({ serverUrl: 'https://example-sonarqube.com' });

    await integrateClaude({});

    const lastHealthCheckCall = runHealthChecksSpy.mock.calls.at(-1)!;
    expect(lastHealthCheckCall[0]).toBe(SERVER_AUTH.serverUrl);
  });

  it('auth server overrides default server', async () => {
    resolveAuthSpy.mockResolvedValue(SERVER_AUTH);
    mockDiscoveredProject({});

    await integrateClaude({});

    const lastHealthCheckCall = runHealthChecksSpy.mock.calls.at(-1)!;
    expect(lastHealthCheckCall[0]).toBe(SERVER_AUTH.serverUrl);
  });

  it('discovered server overrides default server', async () => {
    mockNoAuth();
    mockDiscoveredProject({ serverUrl: 'https://example-sonarqube.com' });

    await integrateClaude({});

    const lastHealthCheckCall = runHealthChecksSpy.mock.calls.at(-1)!;
    expect(lastHealthCheckCall[0]).toBe('https://example-sonarqube.com');
  });

  it('shows warning when resolved server does not match discovered server', async () => {
    resolveAuthSpy.mockResolvedValue(CLOUD_AUTH);
    mockDiscoveredProject({ serverUrl: 'https://example-sonarqube.com' });

    await integrateClaude({});

    const warnText = getMockUiCalls().find(
      (c) => c.method === 'warn' && String(c.args[0]).includes('Server URL mismatch'),
    );
    expect(warnText).toBeDefined();
  });

  it('organization defaults to discovered organization when no auth provided', async () => {
    mockNoAuth();
    mockDiscoveredProject({ organization: 'an-org' });

    await integrateClaude({});

    const lastHealthCheckCall = runHealthChecksSpy.mock.calls.at(-1)!;
    expect(lastHealthCheckCall[4]).toBe('an-org');
  });

  it('organization option overrides discovered organization', async () => {
    mockNoAuth();
    mockDiscoveredProject({ organization: 'an-org' });

    await integrateClaude({ org: 'override-org' });

    const lastHealthCheckCall = runHealthChecksSpy.mock.calls.at(-1)!;
    expect(lastHealthCheckCall[4]).toBe('override-org');
  });

  it('organization option overrides auth organization', async () => {
    mockDiscoveredProject({ organization: 'not-considered-org' });

    await integrateClaude({ org: 'override-org' });

    const resolveAuthCall = resolveAuthSpy.mock.calls.at(0) as Parameters<
      typeof authResolver.resolveAuth
    >;
    expect(resolveAuthCall[0].org).toBe('override-org');
  });

  it('auth organization overrides discovered organization', async () => {
    resolveAuthSpy.mockResolvedValue(CLOUD_AUTH);
    mockDiscoveredProject({ organization: 'an-org' });

    await integrateClaude({});

    const lastHealthCheckCall = runHealthChecksSpy.mock.calls.at(-1)!;
    expect(lastHealthCheckCall[4]).toBe(CLOUD_AUTH.orgKey);
  });

  it('shows warning when resolved organization does not match discovered organization', async () => {
    resolveAuthSpy.mockResolvedValue(CLOUD_AUTH);
    mockDiscoveredProject({ organization: 'an-org' });

    await integrateClaude({});

    const warnText = getMockUiCalls().find(
      (c) => c.method === 'warn' && String(c.args[0]).includes('organization mismatch'),
    );
    expect(warnText).toBeDefined();
  });

  it('validates organization is provided when server is SonarQube Cloud', () => {
    mockNoAuth();
    mockDiscoveredProject({});

    expect(() => integrateClaude({})).toThrow(CommandFailedError);
  });

  it('token defaults to token option when no auth provided', async () => {
    mockNoAuth();
    mockDiscoveredProject({});

    await integrateClaude({ token: 'a-token', org: 'an-org' });

    const lastHealthCheckCall = runHealthChecksSpy.mock.calls.at(-1)!;
    expect(lastHealthCheckCall[1]).toBe('a-token');
  });

  it('token option overrides auth token', async () => {
    await integrateClaude({ token: 'a-token', org: 'an-org' });

    const resolveAuthCall = resolveAuthSpy.mock.calls.at(0) as Parameters<
      typeof authResolver.resolveAuth
    >;
    expect(resolveAuthCall[0].token).toBe('a-token');
  });

  it('project key defaults to discovered project key', async () => {
    mockNoAuth();
    mockDiscoveredProject({ projectKey: 'project' });

    await integrateClaude({ org: 'an-org' });

    const lastHealthCheckCall = runHealthChecksSpy.mock.calls.at(-1)!;
    expect(lastHealthCheckCall[2]).toBe('project');
  });

  it('project key overrides discovered project key', async () => {
    mockNoAuth();
    mockDiscoveredProject({ projectKey: 'project' });

    await integrateClaude({ project: 'override-project', org: 'an-org' });

    const lastHealthCheckCall = runHealthChecksSpy.mock.calls.at(-1)!;
    expect(lastHealthCheckCall[2]).toBe('override-project');
  });

  it('shows phase 2 text', async () => {
    resolveAuthSpy.mockResolvedValue(SERVER_AUTH);

    await integrateClaude({});

    const phaseText = getMockUiCalls().find(
      (c) => c.method === 'text' && String(c.args[0]) === 'Phase 2/3: Health Check & Repair',
    );
    expect(phaseText).toBeDefined();
  });

  it('shows success message on heath check success', async () => {
    resolveAuthSpy.mockResolvedValue(SERVER_AUTH);

    await integrateClaude({});

    const successText = getMockUiCalls().find(
      (c) =>
        c.method === 'success' &&
        String(c.args[0]).includes('All checks passed! Configuration is healthy.'),
    );
    expect(successText).toBeDefined();
  });

  it('shows warning message when heath check fails', async () => {
    resolveAuthSpy.mockResolvedValue(SERVER_AUTH);
    repairTokenSpy.mockResolvedValue('repaired-token');
    mockHealthCheckOnce({
      tokenValid: false,
      errors: ['HealthError1', 'HealthError2', 'HealthError3'],
    });
    mockHealthCheck();

    await integrateClaude({});

    const warnText = getMockUiCalls().find(
      (c) => c.method === 'warn' && String(c.args[0]).includes('Found 3 issue(s):'),
    );
    expect(warnText).toBeDefined();
  });

  it('shows heath check failures in detail', async () => {
    resolveAuthSpy.mockResolvedValue(SERVER_AUTH);
    repairTokenSpy.mockResolvedValue('repaired-token');
    mockHealthCheckOnce({
      tokenValid: false,
      errors: ['HealthError1', 'HealthError2', 'HealthError3'],
    });
    mockHealthCheck();

    await integrateClaude({});

    const healthText = getMockUiCalls()
      .filter((c) => c.method === 'text' && String(c.args[0]).includes('HealthError'))
      .map((c) => String(c.args[0]));
    expect(healthText).toBeArrayOfSize(3);
    expect(healthText).toEqual(['  - HealthError1', '  - HealthError2', '  - HealthError3']);
  });

  it('attempts repair when no token', async () => {
    repairTokenSpy.mockResolvedValue('repaired-token');
    mockHealthCheckOnce({ tokenValid: false, errors: ['Token is invalid'] });
    mockHealthCheck();

    await integrateClaude({ org: 'an-org' });

    expect(repairTokenSpy).toHaveBeenCalledTimes(1);
    expect(repairTokenSpy).toHaveBeenCalledWith('https://sonarcloud.io', 'an-org');
  });

  it('attempts repair when health fails for token', async () => {
    resolveAuthSpy.mockResolvedValue(SERVER_AUTH);
    repairTokenSpy.mockResolvedValue('repaired-token');
    mockHealthCheckOnce({ tokenValid: false, errors: ['Token is invalid'] });
    mockHealthCheck();

    await integrateClaude({});

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

    await integrateClaude({ nonInteractive: true, org: 'an-org' });

    expect(repairTokenSpy).not.toBeCalled();
  });

  it('does not repair token when env variable based auth provided', async () => {
    repairTokenSpy.mockResolvedValue('repaired-token');
    runHealthChecksSpy.mockResolvedValue({
      ...CLEAN_HEALTH,
      tokenValid: false,
      errors: ['Token is invalid'],
    });
    isEnvBasedAuthSpy.mockReturnValue(true);

    await integrateClaude({ org: 'an-org' });

    expect(repairTokenSpy).not.toBeCalled();
  });

  it('checks A3S entitlement when token is provided', async () => {
    resolveAuthSpy.mockResolvedValue(CLOUD_AUTH);
    hasA3sEntitlementSpy.mockResolvedValue(true);

    await integrateClaude({});

    expect(hasA3sEntitlementSpy).toHaveBeenCalledTimes(1);
  });

  it('skips A3S entitlement when token is not provided', async () => {
    mockNoAuth();
    hasA3sEntitlementSpy.mockResolvedValue(true);

    await integrateClaude({ org: 'an-org' });

    expect(hasA3sEntitlementSpy).not.toBeCalled();
  });

  it('runs migration, installs hooks and updates state when health check succeeds', async () => {
    resolveAuthSpy.mockResolvedValue(CLOUD_AUTH);
    mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
    mockA3sEntitlement(true);

    await integrateClaude({});

    assertMigrationHookInstallationAndStateUpdateRan(
      'a-project',
      '/project/root',
      undefined,
      false,
      true,
    );
  });

  it('runs migration, installs hooks and updates state when global option and health check succeeds', async () => {
    resolveAuthSpy.mockResolvedValue(CLOUD_AUTH);
    mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
    mockA3sEntitlement(true);

    await integrateClaude({ global: true });

    assertMigrationHookInstallationAndStateUpdateRan(
      'a-project',
      '/project/root',
      homedir(),
      true,
      true,
    );
  });

  it('runs migration, installs hooks and updates state when health check fails', async () => {
    resolveAuthSpy.mockResolvedValue(CLOUD_AUTH);
    mockDiscoveredProject({ rootDir: '/project/root', projectKey: 'a-project' });
    mockA3sEntitlement(true);
    mockHealthCheck({ organizationAccessible: false, errors: ['Organization not accessible'] });

    await integrateClaude({});

    assertMigrationHookInstallationAndStateUpdateRan(
      'a-project',
      '/project/root',
      undefined,
      false,
      true,
    );
  });

  it('runs migration, installs hooks and updates state when project key is missing', async () => {
    resolveAuthSpy.mockResolvedValue(CLOUD_AUTH);
    mockDiscoveredProject({ rootDir: '/projectB/root' });
    mockA3sEntitlement(false);

    await integrateClaude({});

    assertMigrationHookInstallationAndStateUpdateRan(
      undefined,
      '/projectB/root',
      undefined,
      false,
      false,
    );
  });

  it('shows phase 3 text', async () => {
    resolveAuthSpy.mockResolvedValue(SERVER_AUTH);

    await integrateClaude({});

    const phaseText = getMockUiCalls().find(
      (c) => c.method === 'text' && String(c.args[0]) === 'Phase 3/3: Final Verification',
    );
    expect(phaseText).toBeDefined();
  });

  it('shows outro message', async () => {
    resolveAuthSpy.mockResolvedValue(SERVER_AUTH);

    await integrateClaude({});

    const phaseText = getMockUiCalls().find(
      (c) => c.method === 'outro' && String(c.args[0]) === 'Setup complete!',
    );
    expect(phaseText).toBeDefined();
  });

  it('shows warning message when final heath check fails', async () => {
    resolveAuthSpy.mockResolvedValue(SERVER_AUTH);
    repairTokenSpy.mockResolvedValue('repaired-token');
    mockHealthCheckOnce({ errors: ['HealthError1', 'HealthError2', 'HealthError3'] });
    mockHealthCheck({ errors: ['RemainingHealthError1', 'RemainingHealthError3'] });

    await integrateClaude({});

    const warnText = getMockUiCalls().find(
      (c) => c.method === 'warn' && String(c.args[0]).includes('Some issues remain:'),
    );
    expect(warnText).toBeDefined();
  });

  it('shows final heath check failures in detail', async () => {
    resolveAuthSpy.mockResolvedValue(SERVER_AUTH);
    repairTokenSpy.mockResolvedValue('repaired-token');
    mockHealthCheckOnce({ errors: ['HealthError1', 'HealthError2', 'HealthError3'] });
    mockHealthCheck({ errors: ['RemainingHealthError1', 'RemainingHealthError3'] });

    await integrateClaude({});

    const healthText = getMockUiCalls()
      .filter((c) => c.method === 'text' && String(c.args[0]).includes('RemainingHealthError'))
      .map((c) => String(c.args[0]));
    expect(healthText).toBeArrayOfSize(2);
    expect(healthText).toEqual(['  - RemainingHealthError1', '  - RemainingHealthError3']);
  });

  it('shows secrets hook example when hooks installed', async () => {
    resolveAuthSpy.mockResolvedValue(SERVER_AUTH);

    await integrateClaude({});

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

  it('skips secrets hook example when hooks not installed', async () => {
    resolveAuthSpy.mockResolvedValue(SERVER_AUTH);
    mockHealthCheck({ hooksInstalled: false });

    await integrateClaude({});

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

  function mockNoAuth() {
    resolveAuthSpy.mockImplementation(() => {
      throw new Error('No auth');
    });
  }

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

  function mockA3sEntitlement(hasEntitlement: boolean) {
    hasA3sEntitlementSpy.mockResolvedValue(hasEntitlement);
  }

  function assertMigrationHookInstallationAndStateUpdateRan(
    projectKey: string | undefined,
    projectRootDir: string,
    globalDir: string | undefined,
    isGlobal: boolean,
    a3sEnabled: boolean,
  ): void {
    expect(runMigrationsSpy).toHaveBeenCalledTimes(1);
    expect(runMigrationsSpy).toHaveBeenCalledWith(
      projectRootDir,
      globalDir,
      a3sEnabled,
      projectKey,
    );
    expect(installHooksSpy).toHaveBeenCalledTimes(1);
    expect(installHooksSpy).toHaveBeenCalledWith(projectRootDir, globalDir, a3sEnabled, projectKey);
    expect(updateStateAfterConfigurationSpy).toHaveBeenCalledTimes(1);
    expect(updateStateAfterConfigurationSpy).toHaveBeenCalledWith(
      expect.anything(),
      projectRootDir,
      isGlobal,
      a3sEnabled,
    );
  }
});
