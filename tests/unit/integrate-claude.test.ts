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

// Unit tests for CLI command: `sonar integrate claude` (see command-tree.ts → integrate claude).

import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test';
import * as nodeFs from 'node:fs';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import * as nodeOs from 'node:os';
import { join } from 'node:path';
import * as discovery from '../../src/cli/commands/_common/discovery';
import { DiscoveredProject } from '../../src/cli/commands/_common/discovery';
import { CommandFailedError } from '../../src/cli/commands/_common/error';
import * as token from '../../src/cli/commands/_common/token';
import * as installSecrets from '../../src/cli/commands/_common/install/secrets';
import { integrateClaude } from '../../src/cli/commands/integrate/claude';
import { HealthCheckResult, runHealthChecks } from '../../src/cli/commands/integrate/claude/health';
import * as health from '../../src/cli/commands/integrate/claude/health';
import * as mcp from '../../src/cli/commands/integrate/claude/mcp';
import {
  getSecretPreToolTemplateWindows,
  getSecretPromptTemplateWindows,
  getSqaaPostToolTemplateWindows,
} from '../../src/cli/commands/integrate/claude/hook-templates';
import * as hooks from '../../src/cli/commands/integrate/claude/hooks';
import * as repair from '../../src/cli/commands/integrate/claude/repair';
import * as state from '../../src/cli/commands/integrate/claude/state';
import {
  getSecretPreToolTemplateUnix,
  getSecretPromptTemplateUnix,
  getSqaaPostToolTemplateUnix,
} from '../../src/cli/commands/integrate/_common/unix-agent-hook-templates';
import * as authResolver from '../../src/lib/auth-resolver';
import type { ResolvedAuth } from '../../src/lib/auth-resolver';
import { CLAUDE_AGENT_DIR_NAME } from '../../src/lib/config-constants';
import * as migration from '../../src/lib/migration';
import * as toolDetector from '../../src/lib/tool-detector';
import { getDefaultState } from '../../src/lib/state';
import * as stateManager from '../../src/lib/state-manager';
import { SonarQubeClient } from '../../src/sonarqube/client';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../src/ui';

describe('sonar integrate claude', () => {
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

  describe('orchestration (integrateClaude)', () => {
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
    let runMigrationsSpy: Mock<
      Extract<(typeof migration)['runMigrations'], (...args: any[]) => any>
    >;
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
      runMigrationsSpy.mockRestore();
      updateStateAfterConfigurationSpy.mockRestore();
      resolveSecretsBinarySpy.mockRestore();
      setupMcpServerSpy.mockRestore();
    });

    it('shows intro message', async () => {
      await integrateClaude({}, SERVER_AUTH);

      const introText = getMockUiCalls().find(
        (c) =>
          c.method === 'intro' && String(c.args[0]) === 'SonarQube Integration Setup for Claude',
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
          String(c.args[0]).search(/Can you push a commit using my token ghp_\w+\?/) > -1,
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
          String(c.args[0]).search(/Can you push a commit using my token ghp_\w+\?/) > -1,
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
      expect(runMigrationsSpy).toHaveBeenCalledTimes(1);
      expect(runMigrationsSpy).toHaveBeenCalledWith(
        projectRootDir,
        globalDir,
        sqaaEnabled,
        projectKey,
      );
      expect(installHooksSpy).toHaveBeenCalledTimes(1);
      expect(installHooksSpy).toHaveBeenCalledWith(
        projectRootDir,
        globalDir,
        sqaaEnabled,
        projectKey,
      );
      expect(updateStateAfterConfigurationSpy).toHaveBeenCalledTimes(1);
      expect(updateStateAfterConfigurationSpy).toHaveBeenCalledWith(
        expect.anything(),
        projectRootDir,
        isGlobal,
        sqaaEnabled,
      );
    }
  });
  const PROJECT_ROOT = '/fake/project';
  const GLOBAL_DIR = '/fake/global';
  const PROJECT_KEY = 'my-project';

  /** Normalize path separators to forward slashes for cross-platform assertions. */
  const normPath = (s: string) => s.replaceAll('\\', '/');

  interface AgentSettings {
    hooks?: Record<
      string,
      Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>
    >;
    [key: string]: unknown;
  }

  function getSettingsWriteFor(hookType: string): AgentSettings | undefined {
    return writeFileSpy.mock.calls
      .filter(([path]) => (path as string).includes('settings.json'))
      .map(([, content]) => JSON.parse(content as string) as AgentSettings)
      .find((s) => s.hooks?.[hookType]);
  }

  function getScriptWriteFor(nameFragment: string): string | undefined {
    const call = writeFileSpy.mock.calls.find(([path]) => (path as string).includes(nameFragment));
    return call ? (call[1] as string) : undefined;
  }

  function getScriptPathFor(nameFragment: string): string | undefined {
    const call = writeFileSpy.mock.calls.find(([path]) => (path as string).includes(nameFragment));
    return call ? (call[0] as string) : undefined;
  }

  let writeFileSpy: Mock<Extract<(typeof fsPromises)['writeFile'], (...args: any[]) => any>>;

  describe('areHooksInstalled', () => {
    let existsSyncSpy: Mock<Extract<(typeof nodeFs)['existsSync'], (...args: any[]) => any>>;
    let readFileSpy: Mock<Extract<(typeof fsPromises)['readFile'], (...args: any[]) => any>>;

    beforeEach(() => {
      existsSyncSpy = spyOn(nodeFs, 'existsSync').mockReturnValue(true);
      readFileSpy = spyOn(fsPromises, 'readFile').mockResolvedValue('{}');
    });

    afterEach(() => {
      existsSyncSpy.mockRestore();
      readFileSpy.mockRestore();
    });

    it('returns false when settings.json does not exist', async () => {
      existsSyncSpy.mockReturnValue(false);

      const result = await hooks.areHooksInstalled(PROJECT_ROOT);

      expect(result).toBe(false);
    });

    it('looks for settings.json in the .claude subdirectory', async () => {
      existsSyncSpy.mockReturnValue(false);

      await hooks.areHooksInstalled(PROJECT_ROOT);

      const checkedPath = String(existsSyncSpy.mock.calls[0][0]);
      expect(checkedPath).toContain(CLAUDE_AGENT_DIR_NAME);
      expect(checkedPath).toContain('settings.json');
    });

    it('returns true when PreToolUse has a sonar-secrets command', async () => {
      const settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Read',
              hooks: [
                {
                  type: 'command',
                  command: `${CLAUDE_AGENT_DIR_NAME}/hooks/sonar-secrets/pretool.sh`,
                  timeout: 60,
                },
              ],
            },
          ],
        },
      };
      readFileSpy.mockResolvedValue(JSON.stringify(settings));

      const result = await hooks.areHooksInstalled(PROJECT_ROOT);

      expect(result).toBe(true);
    });

    it('returns false when settings has no hooks property', async () => {
      readFileSpy.mockResolvedValue(JSON.stringify({}));

      const result = await hooks.areHooksInstalled(PROJECT_ROOT);

      expect(result).toBe(false);
    });

    it('returns false when PreToolUse is empty', async () => {
      readFileSpy.mockResolvedValue(JSON.stringify({ hooks: { PreToolUse: [] } }));

      const result = await hooks.areHooksInstalled(PROJECT_ROOT);

      expect(result).toBe(false);
    });

    it('returns false when PreToolUse entry does not reference sonar-secrets', async () => {
      const settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Read',
              hooks: [{ type: 'command', command: '/usr/local/bin/other-tool.sh', timeout: 60 }],
            },
          ],
        },
      };
      readFileSpy.mockResolvedValue(JSON.stringify(settings));

      const result = await hooks.areHooksInstalled(PROJECT_ROOT);

      expect(result).toBe(false);
    });

    it('returns false when settings.json contains malformed JSON', async () => {
      readFileSpy.mockResolvedValue('{ invalid json !!!');

      const result = await hooks.areHooksInstalled(PROJECT_ROOT);

      expect(result).toBe(false);
    });
  });

  describe('installHooks', () => {
    let existsSyncSpy: Mock<Extract<(typeof nodeFs)['existsSync'], (...args: any[]) => any>>;
    let mkdirSyncSpy: Mock<Extract<(typeof nodeFs)['mkdirSync'], (...args: any[]) => any>>;
    let readFileSpy: Mock<Extract<(typeof fsPromises)['readFile'], (...args: any[]) => any>>;
    let platformSpy: Mock<Extract<(typeof nodeOs)['platform'], (...args: any[]) => any>>;

    beforeEach(() => {
      existsSyncSpy = spyOn(nodeFs, 'existsSync').mockReturnValue(false);
      mkdirSyncSpy = spyOn(nodeFs, 'mkdirSync').mockReturnValue(undefined);
      readFileSpy = spyOn(fsPromises, 'readFile').mockResolvedValue('{"hooks":{}}');
      writeFileSpy = spyOn(fsPromises, 'writeFile').mockResolvedValue(undefined);
      platformSpy = spyOn(nodeOs, 'platform').mockReturnValue('linux');
    });

    afterEach(() => {
      existsSyncSpy.mockRestore();
      mkdirSyncSpy.mockRestore();
      readFileSpy.mockRestore();
      writeFileSpy.mockRestore();
      platformSpy.mockRestore();
    });

    it('writes the pretool-secrets script file', async () => {
      await hooks.installHooks(PROJECT_ROOT);

      expect(getScriptPathFor('pretool-secrets')).toBeDefined();
    });

    it('writes the prompt-secrets script file', async () => {
      await hooks.installHooks(PROJECT_ROOT);

      expect(getScriptPathFor('prompt-secrets')).toBeDefined();
    });

    it('does not write the posttool-sqaa script when installSqaa is false', async () => {
      await hooks.installHooks(PROJECT_ROOT, undefined, false);

      expect(getScriptPathFor('posttool-sqaa')).toBeUndefined();
    });

    it('does not write the posttool-sqaa script when projectKey is not provided', async () => {
      await hooks.installHooks(PROJECT_ROOT, undefined, true);

      expect(getScriptPathFor('posttool-sqaa')).toBeUndefined();
    });

    it('writes the posttool-sqaa script when installSqaa is true and projectKey is provided', async () => {
      await hooks.installHooks(PROJECT_ROOT, undefined, true, PROJECT_KEY);

      expect(getScriptPathFor('posttool-sqaa')).toBeDefined();
    });

    it('installs secrets scripts to globalDir when globalDir is provided', async () => {
      await hooks.installHooks(PROJECT_ROOT, GLOBAL_DIR);

      expect(normPath(getScriptPathFor('pretool-secrets') ?? '')).toContain(GLOBAL_DIR);
    });

    it('installs secrets scripts to projectRoot when globalDir is not provided', async () => {
      await hooks.installHooks(PROJECT_ROOT);

      expect(normPath(getScriptPathFor('pretool-secrets') ?? '')).toContain(PROJECT_ROOT);
    });

    it('installs SQAA script to projectRoot even when globalDir is set', async () => {
      await hooks.installHooks(PROJECT_ROOT, GLOBAL_DIR, true, PROJECT_KEY);

      const sqaaPath = normPath(getScriptPathFor('posttool-sqaa') ?? '');
      expect(sqaaPath).toContain(PROJECT_ROOT);
      expect(sqaaPath).not.toContain(GLOBAL_DIR);
    });

    it('writes a PreToolUse hook entry with Read matcher', async () => {
      await hooks.installHooks(PROJECT_ROOT);

      const settings = getSettingsWriteFor('PreToolUse');
      expect(settings?.hooks?.PreToolUse?.[0]?.matcher).toBe('Read');
    });

    it('writes a UserPromptSubmit hook entry with wildcard matcher', async () => {
      await hooks.installHooks(PROJECT_ROOT);

      const settings = getSettingsWriteFor('UserPromptSubmit');
      expect(settings?.hooks?.UserPromptSubmit?.[0]?.matcher).toBe('*');
    });

    it('writes a PostToolUse hook entry with Edit|Write matcher when SQAA is enabled', async () => {
      await hooks.installHooks(PROJECT_ROOT, undefined, true, PROJECT_KEY);

      const settings = getSettingsWriteFor('PostToolUse');
      expect(settings?.hooks?.PostToolUse?.[0]?.matcher).toBe('Edit|Write');
    });

    it('uses a relative command path for project scope (no globalDir)', async () => {
      await hooks.installHooks(PROJECT_ROOT);

      const settings = getSettingsWriteFor('PreToolUse');
      const command = settings?.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
      expect(String(command).startsWith(CLAUDE_AGENT_DIR_NAME)).toBe(true);
    });

    it('uses an absolute command path for global scope (with globalDir)', async () => {
      await hooks.installHooks(PROJECT_ROOT, GLOBAL_DIR);

      const settings = getSettingsWriteFor('PreToolUse');
      const command = settings?.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
      expect(normPath(String(command))).toContain(GLOBAL_DIR);
    });

    it('uses a relative command path for the SQAA hook regardless of globalDir', async () => {
      await hooks.installHooks(PROJECT_ROOT, GLOBAL_DIR, true, PROJECT_KEY);

      const settings = getSettingsWriteFor('PostToolUse');
      const command = settings?.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command;
      expect(String(command).startsWith(CLAUDE_AGENT_DIR_NAME)).toBe(true);
    });

    it('preserves existing unrelated settings when settings.json already exists', async () => {
      existsSyncSpy.mockReturnValue(true);
      readFileSpy.mockResolvedValue(JSON.stringify({ theme: 'dark', hooks: {} }));

      await hooks.installHooks(PROJECT_ROOT);

      const allWrites = (writeFileSpy.mock.calls as Array<[unknown, unknown]>)
        .filter(([path]) => String(path).includes('settings.json'))
        .map(([, content]) => JSON.parse(String(content)) as AgentSettings);
      expect(allWrites.every((s) => (s as { theme?: string }).theme === 'dark')).toBe(true);
    });

    it('replaces existing sonar-secrets hook entry rather than appending', async () => {
      existsSyncSpy.mockReturnValue(true);
      const existing = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Read',
              hooks: [
                {
                  type: 'command',
                  command: `${CLAUDE_AGENT_DIR_NAME}/hooks/sonar-secrets/old.sh`,
                  timeout: 60,
                },
              ],
            },
          ],
        },
      };
      readFileSpy.mockResolvedValue(JSON.stringify(existing));

      await hooks.installHooks(PROJECT_ROOT);

      const settings = getSettingsWriteFor('PreToolUse');
      expect(settings?.hooks?.PreToolUse).toHaveLength(1);
    });

    it('preserves existing non-sonar PostToolUse entries when adding SQAA hook', async () => {
      existsSyncSpy.mockReturnValue(true);
      const existing = {
        hooks: {
          PostToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo ran', timeout: 60 }] },
          ],
        },
      };
      readFileSpy.mockResolvedValue(JSON.stringify(existing));

      await hooks.installHooks(PROJECT_ROOT, undefined, true, PROJECT_KEY);

      const settings = getSettingsWriteFor('PostToolUse');
      const bashEntry = settings?.hooks?.PostToolUse?.find((e) => e.matcher === 'Bash');
      expect(bashEntry).toBeDefined();
    });

    it('pretool-secrets script contains the sonar analyze secrets command', async () => {
      await hooks.installHooks(PROJECT_ROOT);

      expect(getScriptWriteFor('pretool-secrets')).toContain('analyze secrets');
    });

    it('posttool-sqaa script contains the projectKey', async () => {
      await hooks.installHooks(PROJECT_ROOT, undefined, true, PROJECT_KEY);

      expect(getScriptWriteFor('posttool-sqaa')).toContain(PROJECT_KEY);
    });

    it('writes a .sh script on Unix platforms', async () => {
      await hooks.installHooks(PROJECT_ROOT);

      expect(getScriptPathFor('pretool-secrets')).toContain('.sh');
    });

    it('writes a .ps1 script on Windows platforms', async () => {
      platformSpy.mockReturnValue('win32');

      await hooks.installHooks(PROJECT_ROOT);

      expect(getScriptPathFor('pretool-secrets')).toContain('.ps1');
    });

    it('does not throw when a file system error occurs', async () => {
      writeFileSpy.mockRejectedValue(new Error('ENOENT: no such file'));

      const actual = await hooks.installHooks(PROJECT_ROOT);

      expect(actual).toBeUndefined();
    });
  });
  const MCP_ON_PREMISE_AUTH: ResolvedAuth = {
    token: 'squ_test',
    serverUrl: 'https://sonarqube.example.com',
    connectionType: 'on-premise',
  };

  const MCP_CLOUD_AUTH: ResolvedAuth = {
    token: 'squ_test',
    serverUrl: 'https://sonarcloud.io',
    connectionType: 'cloud',
  };

  const MCP_CLOUD_US_AUTH: ResolvedAuth = {
    token: 'squ_test',
    serverUrl: 'https://sonarqube.us',
    connectionType: 'cloud',
  };

  describe('getMcpServerConfig', () => {
    it('returns a docker command with SONARQUBE_TOKEN and SONARQUBE_URL for on-premise', () => {
      const config = mcp.getMcpServerConfig(MCP_ON_PREMISE_AUTH, true, '/fake/project', undefined);
      expect(config).toEqual({
        command: 'docker',
        args: [
          'run',
          '--init',
          '--pull=always',
          '-i',
          '--rm',
          '-e',
          'SONARQUBE_TOKEN',
          '-e',
          'SONARQUBE_URL',
          'mcp/sonarqube',
        ],
        env: { SONARQUBE_TOKEN: 'squ_test', SONARQUBE_URL: 'https://sonarqube.example.com' },
      });
    });

    it('returns a docker command with SONARQUBE_ORG for cloud (sonarcloud.io)', () => {
      const auth: ResolvedAuth = { ...MCP_CLOUD_AUTH, orgKey: 'my-org' };
      const config = mcp.getMcpServerConfig(auth, true, '/fake/project', undefined);
      expect(config).toEqual({
        command: 'docker',
        args: [
          'run',
          '--init',
          '--pull=always',
          '-i',
          '--rm',
          '-e',
          'SONARQUBE_TOKEN',
          '-e',
          'SONARQUBE_URL',
          '-e',
          'SONARQUBE_ORG',
          'mcp/sonarqube',
        ],
        env: {
          SONARQUBE_TOKEN: 'squ_test',
          SONARQUBE_URL: 'https://sonarcloud.io',
          SONARQUBE_ORG: 'my-org',
        },
      });
    });

    it('returns a docker command with SONARQUBE_ORG for cloud US (sonarqube.us)', () => {
      const auth: ResolvedAuth = { ...MCP_CLOUD_US_AUTH, orgKey: 'my-org' };
      const config = mcp.getMcpServerConfig(auth, true, '/fake/project', undefined);
      expect(config).toEqual({
        command: 'docker',
        args: [
          'run',
          '--init',
          '--pull=always',
          '-i',
          '--rm',
          '-e',
          'SONARQUBE_TOKEN',
          '-e',
          'SONARQUBE_URL',
          '-e',
          'SONARQUBE_ORG',
          'mcp/sonarqube',
        ],
        env: {
          SONARQUBE_TOKEN: 'squ_test',
          SONARQUBE_URL: 'https://sonarqube.us',
          SONARQUBE_ORG: 'my-org',
        },
      });
    });

    it('uses forward slashes in the docker -v host path on Windows-style roots', () => {
      const config = mcp.getMcpServerConfig(
        MCP_ON_PREMISE_AUTH,
        false,
        String.raw`C:\Users\tdd\source\repos\sonarlint-core`,
        undefined,
      );
      const args = (config as { args: string[] }).args;
      const vIndex = args.indexOf('-v');
      expect(vIndex).toBeGreaterThan(-1);
      expect(args[vIndex + 1]).toBe(
        'C:/Users/tdd/source/repos/sonarlint-core:/app/mcp-workspace:ro',
      );
    });

    it('returns a docker command with -v ${projectRoot}:/app/mcp-workspace:ro for non-global config', () => {
      const config = mcp.getMcpServerConfig(MCP_ON_PREMISE_AUTH, false, '/fake/project', undefined);
      expect(config).toEqual({
        command: 'docker',
        args: [
          'run',
          '--init',
          '--pull=always',
          '-i',
          '--rm',
          '-e',
          'SONARQUBE_TOKEN',
          '-e',
          'SONARQUBE_URL',
          '-v',
          '/fake/project:/app/mcp-workspace:ro',
          'mcp/sonarqube',
        ],
        env: { SONARQUBE_TOKEN: 'squ_test', SONARQUBE_URL: 'https://sonarqube.example.com' },
      });
    });

    it('returns a docker command with SONARQUBE_PROJECT_KEY for non-global config with project key', () => {
      const config = mcp.getMcpServerConfig(
        MCP_ON_PREMISE_AUTH,
        false,
        '/fake/project',
        'my-project',
      );
      expect(config).toEqual({
        command: 'docker',
        args: [
          'run',
          '--init',
          '--pull=always',
          '-i',
          '--rm',
          '-e',
          'SONARQUBE_TOKEN',
          '-e',
          'SONARQUBE_URL',
          '-e',
          'SONARQUBE_PROJECT_KEY',
          '-v',
          '/fake/project:/app/mcp-workspace:ro',
          'mcp/sonarqube',
        ],
        env: {
          SONARQUBE_TOKEN: 'squ_test',
          SONARQUBE_URL: 'https://sonarqube.example.com',
          SONARQUBE_PROJECT_KEY: 'my-project',
        },
      });
    });
  });

  describe('getMcpConfigFilePath', () => {
    it('returns ~/.claude.json for the claude agent', () => {
      expect(mcp.getMcpConfigFilePath('claude')).toBe(join(homedir(), '.claude.json'));
    });

    it('throws for an unsupported agent', () => {
      expect(() => mcp.getMcpConfigFilePath('cursor')).toThrow('Unsupported agent: cursor');
    });
  });

  describe('writeMcpServerEntry', () => {
    const tmpFile = join(tmpdir(), `mcp-test-${Date.now()}.json`);

    afterEach(() => {
      rmSync(tmpFile, { force: true });
    });

    it('throws when the existing file contains invalid JSON', () => {
      writeFileSync(tmpFile, 'not valid json', 'utf-8');
      expect(
        mcp.writeMcpServerEntry(tmpFile, { command: 'docker' }, true, '/fake/project'),
      ).rejects.toThrow('contains invalid JSON');
    });

    it('merges sonarqube entry into existing project-specific mcpServers without overwriting other entries', async () => {
      const projectRoot = '/fake/project';
      const existing = {
        projects: {
          [projectRoot]: { mcpServers: { other: { command: 'npx', args: ['other-mcp'] } } },
        },
      };
      writeFileSync(tmpFile, JSON.stringify(existing), 'utf-8');

      const serverConfig = { command: 'docker', args: ['run', 'mcp/sonarqube'] };
      await mcp.writeMcpServerEntry(tmpFile, serverConfig, false, projectRoot);

      const written = JSON.parse(readFileSync(tmpFile, 'utf-8')) as Record<string, unknown>;
      const projects = written.projects as Record<string, unknown>;
      const mcpServers = (projects[projectRoot] as Record<string, unknown>).mcpServers as Record<
        string,
        unknown
      >;
      expect(mcpServers['other']).toEqual({ command: 'npx', args: ['other-mcp'] });
      expect(mcpServers['sonarqube']).toEqual(serverConfig);
    });

    it('writes projects keys with forward slashes when projectRoot uses backslashes', async () => {
      const winRoot = String.raw`C:\Users\tdd\source\repos\sonarlint-core`;
      const serverConfig = { command: 'docker', args: ['run', 'mcp/sonarqube'] };
      await mcp.writeMcpServerEntry(tmpFile, serverConfig, false, winRoot);

      const written = JSON.parse(readFileSync(tmpFile, 'utf-8')) as Record<string, unknown>;
      const projects = written.projects as Record<string, unknown>;
      expect(Object.keys(projects)).toEqual(['C:/Users/tdd/source/repos/sonarlint-core']);
    });

    it('merges sonarqube entry into existing global mcpServers without overwriting other entries', async () => {
      const existing = { mcpServers: { other: { command: 'npx', args: ['other-mcp'] } } };
      writeFileSync(tmpFile, JSON.stringify(existing), 'utf-8');

      const serverConfig = { command: 'docker', args: ['run', 'mcp/sonarqube'] };
      await mcp.writeMcpServerEntry(tmpFile, serverConfig, true, '/fake/project');

      const written = JSON.parse(readFileSync(tmpFile, 'utf-8')) as Record<string, unknown>;
      const mcpServers = written.mcpServers as Record<string, unknown>;
      expect(mcpServers['other']).toEqual({ command: 'npx', args: ['other-mcp'] });
      expect(mcpServers['sonarqube']).toEqual(serverConfig);
    });
  });

  describe('setupMcpServer', () => {
    let dockerSpy: ReturnType<typeof spyOn>;
    let writeSpy: ReturnType<typeof spyOn>;

    afterEach(() => {
      dockerSpy.mockRestore();
      writeSpy?.mockRestore();
      setMockUi(false);
    });

    it('skips MCP configuration and prints an error when docker is unavailable for cloud auth', async () => {
      setMockUi(true);
      dockerSpy = spyOn(toolDetector, 'isDockerAvailable').mockResolvedValue(false);

      await mcp.setupMcpServer('claude', '/fake/project', false, CLOUD_AUTH, undefined);

      const messages = getMockUiCalls().map((c) => String(c.args[0]));
      expect(messages.some((m) => m.includes('Docker is required'))).toBe(true);
      expect(messages.some((m) => m.includes('Skipping SonarQube MCP Server configuration'))).toBe(
        true,
      );
    });

    it('logs an error when writing the MCP entry fails', async () => {
      setMockUi(true);
      dockerSpy = spyOn(toolDetector, 'isDockerAvailable').mockResolvedValue(true);
      writeSpy = spyOn(mcp, 'writeMcpServerEntry').mockRejectedValue(new Error('disk full'));

      await mcp.setupMcpServer('claude', '/fake/project', false, MCP_ON_PREMISE_AUTH, undefined);

      const errors = getMockUiCalls()
        .filter((c) => c.method === 'error')
        .map((c) => String(c.args[0]));
      expect(errors.some((m) => m.includes('disk full'))).toBe(true);
    });
  });
  const SERVER = 'https://sonarcloud.io';
  const TOKEN = 'squ_test';
  const PROJECT = 'my-project';
  const ROOT = '/fake/root';
  const ORG = 'my-org';

  describe('runHealthChecks: all checks pass', () => {
    let validateSpy: ReturnType<typeof spyOn>;
    let statusSpy: ReturnType<typeof spyOn>;
    let componentSpy: ReturnType<typeof spyOn>;
    let orgSpy: ReturnType<typeof spyOn>;
    let profilesSpy: ReturnType<typeof spyOn>;
    let hooksSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      setMockUi(true);
      validateSpy = spyOn(token, 'validateToken').mockResolvedValue(true);
      statusSpy = spyOn(SonarQubeClient.prototype, 'getSystemStatus').mockResolvedValue({
        status: 'UP',
        version: '1.0',
      });
      componentSpy = spyOn(SonarQubeClient.prototype, 'checkComponent').mockResolvedValue(true);
      orgSpy = spyOn(SonarQubeClient.prototype, 'checkOrganization').mockResolvedValue(true);
      profilesSpy = spyOn(SonarQubeClient.prototype, 'checkQualityProfiles').mockResolvedValue(
        true,
      );
      hooksSpy = spyOn(hooks, 'areHooksInstalled').mockResolvedValue(true);
    });

    afterEach(() => {
      validateSpy.mockRestore();
      statusSpy.mockRestore();
      componentSpy.mockRestore();
      orgSpy.mockRestore();
      profilesSpy.mockRestore();
      hooksSpy.mockRestore();
      setMockUi(false);
    });

    it('returns all true fields when every check passes', async () => {
      const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT, ORG);
      expect(result.tokenValid).toBe(true);
      expect(result.serverAvailable).toBe(true);
      expect(result.projectAccessible).toBe(true);
      expect(result.organizationAccessible).toBe(true);
      expect(result.qualityProfilesAccessible).toBe(true);
      expect(result.hooksInstalled).toBe(true);
    });

    it('returns empty errors array when all checks pass', async () => {
      const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT, ORG);
      expect(result.errors).toHaveLength(0);
    });

    it('skips organization check when org is not provided', async () => {
      const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT);
      expect(orgSpy).not.toHaveBeenCalled();
      expect(result.organizationAccessible).toBe(true);
    });
  });

  describe('runHealthChecks: individual failures', () => {
    let validateSpy: ReturnType<typeof spyOn>;
    let statusSpy: ReturnType<typeof spyOn>;
    let componentSpy: ReturnType<typeof spyOn>;
    let orgSpy: ReturnType<typeof spyOn>;
    let profilesSpy: ReturnType<typeof spyOn>;
    let hooksSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      setMockUi(true);
      validateSpy = spyOn(token, 'validateToken').mockResolvedValue(true);
      statusSpy = spyOn(SonarQubeClient.prototype, 'getSystemStatus').mockResolvedValue({
        status: 'UP',
        version: '1.0',
      });
      componentSpy = spyOn(SonarQubeClient.prototype, 'checkComponent').mockResolvedValue(true);
      orgSpy = spyOn(SonarQubeClient.prototype, 'checkOrganization').mockResolvedValue(true);
      profilesSpy = spyOn(SonarQubeClient.prototype, 'checkQualityProfiles').mockResolvedValue(
        true,
      );
      hooksSpy = spyOn(hooks, 'areHooksInstalled').mockResolvedValue(true);
    });

    afterEach(() => {
      validateSpy.mockRestore();
      statusSpy.mockRestore();
      componentSpy.mockRestore();
      orgSpy.mockRestore();
      profilesSpy.mockRestore();
      hooksSpy.mockRestore();
      setMockUi(false);
    });

    it('tokenValid=false and error added when token is invalid', async () => {
      validateSpy.mockResolvedValue(false);
      const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT);
      expect(result.tokenValid).toBe(false);
      expect(result.errors.some((e) => e.includes('Token'))).toBe(true);
    });

    it('serverAvailable=false when getSystemStatus throws', async () => {
      statusSpy.mockRejectedValue(new Error('connection refused'));
      const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT);
      expect(result.serverAvailable).toBe(false);
      expect(result.errors.some((e) => e.includes('Server'))).toBe(true);
    });

    it('projectAccessible=false when checkComponent returns false', async () => {
      componentSpy.mockResolvedValue(false);
      const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT);
      expect(result.projectAccessible).toBe(false);
      expect(result.errors.some((e) => e.includes(PROJECT))).toBe(true);
    });

    it('organizationAccessible=false when checkOrganization returns false', async () => {
      orgSpy.mockResolvedValue(false);
      const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT, ORG);
      expect(result.organizationAccessible).toBe(false);
      expect(result.errors.some((e) => e.includes(ORG))).toBe(true);
    });

    it('qualityProfilesAccessible=false when checkQualityProfiles returns false', async () => {
      profilesSpy.mockResolvedValue(false);
      const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT);
      expect(result.qualityProfilesAccessible).toBe(false);
      expect(result.errors.some((e) => e.toLowerCase().includes('quality'))).toBe(true);
    });

    it('hooksInstalled=false when areHooksInstalled returns false', async () => {
      hooksSpy.mockResolvedValue(false);
      const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT);
      expect(result.hooksInstalled).toBe(false);
      expect(result.errors.some((e) => e.includes('Hooks'))).toBe(true);
    });
  });

  describe('runHealthChecks: multiple failures collect all errors', () => {
    let validateSpy: ReturnType<typeof spyOn>;
    let statusSpy: ReturnType<typeof spyOn>;
    let componentSpy: ReturnType<typeof spyOn>;
    let profilesSpy: ReturnType<typeof spyOn>;
    let hooksSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      setMockUi(true);
      validateSpy = spyOn(token, 'validateToken').mockResolvedValue(false);
      statusSpy = spyOn(SonarQubeClient.prototype, 'getSystemStatus').mockRejectedValue(
        new Error('down'),
      );
      componentSpy = spyOn(SonarQubeClient.prototype, 'checkComponent').mockResolvedValue(false);
      profilesSpy = spyOn(SonarQubeClient.prototype, 'checkQualityProfiles').mockResolvedValue(
        false,
      );
      hooksSpy = spyOn(hooks, 'areHooksInstalled').mockResolvedValue(false);
    });

    afterEach(() => {
      validateSpy.mockRestore();
      statusSpy.mockRestore();
      componentSpy.mockRestore();
      profilesSpy.mockRestore();
      hooksSpy.mockRestore();
      setMockUi(false);
    });

    it('collects all errors when multiple checks fail', async () => {
      const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT);
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    });

    it('all boolean fields are false when checks fail', async () => {
      const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT);
      expect(result.tokenValid).toBe(false);
      expect(result.serverAvailable).toBe(false);
      expect(result.projectAccessible).toBe(false);
      expect(result.hooksInstalled).toBe(false);
    });
  });

  describe('runHealthChecks: verbose=false', () => {
    let validateSpy: ReturnType<typeof spyOn>;
    let statusSpy: ReturnType<typeof spyOn>;
    let componentSpy: ReturnType<typeof spyOn>;
    let profilesSpy: ReturnType<typeof spyOn>;
    let hooksSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      setMockUi(true);
      validateSpy = spyOn(token, 'validateToken').mockResolvedValue(true);
      statusSpy = spyOn(SonarQubeClient.prototype, 'getSystemStatus').mockResolvedValue({
        status: 'UP',
        version: '1.0',
      });
      componentSpy = spyOn(SonarQubeClient.prototype, 'checkComponent').mockResolvedValue(true);
      profilesSpy = spyOn(SonarQubeClient.prototype, 'checkQualityProfiles').mockResolvedValue(
        true,
      );
      hooksSpy = spyOn(hooks, 'areHooksInstalled').mockResolvedValue(true);
    });

    afterEach(() => {
      validateSpy.mockRestore();
      statusSpy.mockRestore();
      componentSpy.mockRestore();
      profilesSpy.mockRestore();
      hooksSpy.mockRestore();
      setMockUi(false);
    });

    it('still returns correct results when verbose=false', async () => {
      const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT, undefined, false);
      expect(result.tokenValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
  const SERVER_URL = 'https://sonarqube.example.com';
  const NEW_TOKEN = 'new-generated-token';

  describe('repairToken', () => {
    let generateTokenSpy: Mock<
      Extract<(typeof token)['generateTokenViaBrowser'], (...args: any[]) => any>
    >;
    let validateTokenSpy: Mock<Extract<(typeof token)['validateToken'], (...args: any[]) => any>>;
    let saveTokenSpy: Mock<Extract<(typeof token)['saveToken'], (...args: any[]) => any>>;
    let deleteTokenSpy: Mock<Extract<(typeof token)['deleteToken'], (...args: any[]) => any>>;

    beforeEach(() => {
      setMockUi(true);
      generateTokenSpy = spyOn(token, 'generateTokenViaBrowser').mockResolvedValue(NEW_TOKEN);
      validateTokenSpy = spyOn(token, 'validateToken').mockResolvedValue(true);
      saveTokenSpy = spyOn(token, 'saveToken').mockResolvedValue(undefined);
      deleteTokenSpy = spyOn(token, 'deleteToken').mockResolvedValue(undefined);
    });

    afterEach(() => {
      clearMockUiCalls();
      setMockUi(false);
      generateTokenSpy.mockRestore();
      validateTokenSpy.mockRestore();
      saveTokenSpy.mockRestore();
      deleteTokenSpy.mockRestore();
    });

    it('shows "Obtaining access token..." text message', async () => {
      await repair.repairToken(SERVER_URL);

      const msg = getMockUiCalls().find(
        (c) => c.method === 'text' && String(c.args[0]) === 'Obtaining access token...',
      );
      expect(msg).toBeDefined();
    });

    it('shows "Token saved to keychain" success message', async () => {
      await repair.repairToken(SERVER_URL);

      const msg = getMockUiCalls().find(
        (c) => c.method === 'success' && String(c.args[0]) === 'Token saved to keychain',
      );
      expect(msg).toBeDefined();
    });

    it('generates a new token via browser using the provided server URL', async () => {
      await repair.repairToken(SERVER_URL);

      expect(generateTokenSpy).toHaveBeenCalledTimes(1);
      expect(generateTokenSpy).toHaveBeenCalledWith(SERVER_URL);
    });

    it('returns the newly generated token', async () => {
      const actual = await repair.repairToken(SERVER_URL);

      expect(actual).toBe(NEW_TOKEN);
    });

    it('validates the generated token against the server', async () => {
      await repair.repairToken(SERVER_URL);

      expect(validateTokenSpy).toHaveBeenCalledTimes(1);
      expect(validateTokenSpy).toHaveBeenCalledWith(SERVER_URL, NEW_TOKEN);
    });

    it('throws when the generated token fails validation', () => {
      validateTokenSpy.mockResolvedValue(false);

      const actual = repair.repairToken(SERVER_URL);

      expect(actual).rejects.toThrow('Generated token is invalid');
    });

    it('does not save the token when validation fails', async () => {
      validateTokenSpy.mockResolvedValue(false);

      const actual = repair.repairToken(SERVER_URL);

      await actual.catch(() => {});
      expect(saveTokenSpy).not.toHaveBeenCalled();
    });

    it('deletes the old token with the provided organization', async () => {
      await repair.repairToken(SERVER_URL, 'my-org');

      expect(deleteTokenSpy).toHaveBeenCalledTimes(1);
      expect(deleteTokenSpy).toHaveBeenCalledWith(SERVER_URL, 'my-org');
    });

    it('deletes the old token without organization when none is provided', async () => {
      await repair.repairToken(SERVER_URL);

      expect(deleteTokenSpy).toHaveBeenCalledWith(SERVER_URL, undefined);
    });

    it('continues and saves the new token even when deleteToken throws', async () => {
      deleteTokenSpy.mockRejectedValue(new Error('keychain unavailable'));

      await repair.repairToken(SERVER_URL);

      expect(saveTokenSpy).toHaveBeenCalledTimes(1);
    });

    it('does not throw when deleteToken fails', async () => {
      deleteTokenSpy.mockRejectedValue(new Error('keychain locked'));

      const actual = await repair.repairToken(SERVER_URL);

      expect(actual).toBe(NEW_TOKEN);
    });

    it('saves the new token to the keychain with the provided organization', async () => {
      await repair.repairToken(SERVER_URL, 'my-org');

      expect(saveTokenSpy).toHaveBeenCalledTimes(1);
      expect(saveTokenSpy).toHaveBeenCalledWith(SERVER_URL, NEW_TOKEN, 'my-org');
    });

    it('saves the new token to the keychain without organization when none is provided', async () => {
      await repair.repairToken(SERVER_URL);

      expect(saveTokenSpy).toHaveBeenCalledWith(SERVER_URL, NEW_TOKEN, undefined);
    });
  });
  describe('Secret Scanning Hook Templates', () => {
    it('PreTool Unix hook: bash shebang, sonar analyze command, exit code 51', () => {
      const template = getSecretPreToolTemplateUnix();

      expect(template.startsWith('#!/bin/bash')).toBe(true);
      expect(template.includes('"$SONAR" analyze secrets')).toBe(true);
      expect(template.includes('.local/share/sonarqube-cli/bin')).toBe(true);
      expect(template).toMatch(/SONAR=\$\(command -v sonar/);
      expect(template.includes('exit_code -eq 51')).toBe(true);
      expect(template.includes('permissionDecision')).toBe(true);
    });

    it('PreTool Windows hook: PowerShell, sonar analyze command, exit code 51', () => {
      const template = getSecretPreToolTemplateWindows();

      expect(template.includes('sonar analyze secrets')).toBe(true);
      expect(template.includes('$exitCode -eq 51')).toBe(true);
      expect(typeof template).toBe('string');
    });

    it('UserPromptSubmit Unix hook: bash shebang, sonar analyze command, exit code 51', () => {
      const template = getSecretPromptTemplateUnix();

      expect(template.startsWith('#!/bin/bash')).toBe(true);
      expect(template.includes('"$SONAR" analyze secrets')).toBe(true);
      expect(template.includes('.payload.prompt')).toBe(true);
      expect(template.includes('exit_code -eq 51')).toBe(true);
    });

    it('UserPromptSubmit Unix hook resolves sonar via PATH at hook runtime', () => {
      const template = getSecretPromptTemplateUnix();

      expect(template).toMatch(/SONAR=\$\(command -v sonar/);
    });

    it('UserPromptSubmit Windows hook: PowerShell, sonar analyze command, exit code 51', () => {
      const template = getSecretPromptTemplateWindows();

      expect(template.includes('sonar analyze secrets')).toBe(true);
      expect(template.includes('$exitCode -eq 51')).toBe(true);
      expect(typeof template).toBe('string');
    });
  });

  describe('SQAA PostToolUse Hook Templates', () => {
    it('PostTool Unix hook: bash shebang, sonar analyze sqaa command, handles Edit and Write tools', () => {
      const template = getSqaaPostToolTemplateUnix('my-project');

      expect(template.startsWith('#!/bin/bash')).toBe(true);
      expect(template.includes('"$SONAR" analyze sqaa --file')).toBe(true);
      expect(template.includes('"Edit"')).toBe(true);
      expect(template.includes('"Write"')).toBe(true);
    });

    it('PostTool Unix hook: non-blocking (never blocks file operations)', () => {
      const template = getSqaaPostToolTemplateUnix('my-project');

      // Must not emit permissionDecision — PostToolUse is informational only
      expect(template.includes('permissionDecision')).toBe(false);
      // Should be non-blocking (uses || true or similar)
      expect(template.includes('|| true') || template.includes('2>/dev/null')).toBe(true);
    });

    it('PostTool Windows hook: PowerShell, sonar analyze sqaa command, handles Edit and Write tools', () => {
      const template = getSqaaPostToolTemplateWindows('my-project');

      expect(typeof template).toBe('string');
      expect(template.includes('sonar analyze sqaa')).toBe(true);
      expect(template.includes('"Edit"') || template.includes('-ne "Edit"')).toBe(true);
      expect(template.includes('"Write"') || template.includes('-ne "Write"')).toBe(true);
    });

    it('PostTool Windows hook: non-blocking (never blocks file operations)', () => {
      const template = getSqaaPostToolTemplateWindows('my-project');

      expect(template.includes('permissionDecision')).toBe(false);
    });
  });

  describe('Template Integrity', () => {
    it('All 6 templates are valid non-empty strings with distinct content', () => {
      const templates = [
        getSecretPreToolTemplateUnix(),
        getSecretPreToolTemplateWindows(),
        getSecretPromptTemplateUnix(),
        getSecretPromptTemplateWindows(),
        getSqaaPostToolTemplateUnix('p'),
        getSqaaPostToolTemplateWindows('p'),
      ];

      const uniqueContents = new Set(templates);

      templates.forEach((template) => {
        expect(template.length).toBeGreaterThan(0);
        expect(typeof template).toBe('string');
      });

      expect(uniqueContents.size).toBe(6); // All templates are different
    });

    it('No template references old sonar secret check command', () => {
      const templates = [
        getSecretPreToolTemplateUnix(),
        getSecretPreToolTemplateWindows(),
        getSecretPromptTemplateUnix(),
        getSecretPromptTemplateWindows(),
        getSqaaPostToolTemplateUnix('p'),
        getSqaaPostToolTemplateWindows('p'),
      ];

      templates.forEach((template) => {
        expect(template.includes('sonar secret check')).toBe(false);
      });
    });

    it('SQAA templates use sonar analyze sqaa, secrets templates use sonar analyze', () => {
      expect(getSqaaPostToolTemplateUnix('p').includes('analyze sqaa')).toBe(true);
      expect(getSqaaPostToolTemplateWindows('p').includes('sonar analyze sqaa')).toBe(true);

      // Secrets templates should NOT call sonar analyze sqaa
      expect(getSecretPreToolTemplateUnix().includes('analyze sqaa')).toBe(false);
      expect(getSecretPromptTemplateUnix().includes('analyze sqaa')).toBe(false);
    });
  });
});
