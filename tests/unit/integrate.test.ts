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

// Unit tests for sonar integrate command

import { homedir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { integrateClaude } from '../../src/cli/commands/integrate/claude';
import * as discovery from '../../src/cli/commands/_common/discovery';
import * as health from '../../src/cli/commands/integrate/claude/health';
import * as repair from '../../src/cli/commands/integrate/claude/repair';
import * as auth from '../../src/cli/commands/_common/token';
import * as keychain from '../../src/lib/keychain.js';
import * as hooks from '../../src/cli/commands/integrate/claude/hooks';
import * as stateManager from '../../src/lib/state-manager.js';
import { getDefaultState } from '../../src/lib/state.js';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../src/ui';
import { ENV_TOKEN, ENV_SERVER } from '../../src/lib/auth-resolver.js';
import { SonarQubeClient } from '../../src/sonarqube/client.js';

const FAKE_PROJECT_INFO = {
  root: '/fake/project',
  name: 'fake-project',
  isGitRepo: true,
  gitRemote: '',
  hasSonarProps: false,
  sonarPropsData: null,
  hasSonarLintConfig: false,
  sonarLintData: null,
};

const CLEAN_HEALTH = {
  tokenValid: true,
  serverAvailable: true,
  projectAccessible: true,
  organizationAccessible: true,
  qualityProfilesAccessible: true,
  hooksInstalled: true,
  errors: [],
};

// ─── validateAgent ────────────────────────────────────────────────────────────

describe('integrateCommand: validateAgent', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });

  afterEach(() => {
    setMockUi(false);
  });
});

// ─── env var auth warning ─────────────────────────────────────────────────────

describe('integrateCommand: env var auth', () => {
  let discoverSpy: ReturnType<typeof spyOn>;
  let healthSpy: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
    delete process.env[ENV_TOKEN];
    delete process.env[ENV_SERVER];
  });

  afterEach(() => {
    discoverSpy.mockRestore();
    healthSpy.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    delete process.env[ENV_TOKEN];
    delete process.env[ENV_SERVER];
    setMockUi(false);
  });

  it('warns when only SONAR_CLI_TOKEN is set (partial env vars)', async () => {
    process.env[ENV_TOKEN] = 'squ_env_token';
    await integrateClaude({
      server: 'https://sonarcloud.io',
      project: 'my-project',
      token: 'squ_cli_token',
      org: 'my-org',
    });
    const warns = getMockUiCalls()
      .filter((c) => c.method === 'warn')
      .map((c) => String(c.args[0]));
    expect(warns.some((m) => m.includes(ENV_SERVER))).toBe(true);
  });

  it('warns when only SONAR_CLI_SERVER is set (partial env vars)', async () => {
    process.env[ENV_SERVER] = 'https://sonarcloud.io';
    await integrateClaude({
      server: 'https://sonarcloud.io',
      project: 'my-project',
      token: 'squ_cli_token',
      org: 'my-org',
    });
    const warns = getMockUiCalls()
      .filter((c) => c.method === 'warn')
      .map((c) => String(c.args[0]));
    expect(warns.some((m) => m.includes(ENV_TOKEN))).toBe(true);
  });
});

// ─── full flow ────────────────────────────────────────────────────────────────

describe('integrateCommand: full flow', () => {
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
  });

  it('exits 0 when onboarding succeeds with all checks passing', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);

    try {
      await integrateClaude({
        server: 'https://sonarcloud.io',
        project: 'my-project',
        token: 'test-token',
        org: 'test-org',
      });
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
    }
  });

  it('saves active connection to state after successful integration', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);
    const capturedState = getDefaultState('test');
    loadStateSpy.mockReturnValue(capturedState);
    saveStateSpy.mockImplementation(() => {});

    try {
      await integrateClaude({
        server: 'https://sonarcloud.io',
        project: 'my-project',
        token: 'test-token',
        org: 'test-org',
      });

      // Verify connection was added to state
      expect(capturedState.auth.activeConnectionId).toBeDefined();
      expect(capturedState.auth.connections).toHaveLength(1);
      expect(capturedState.auth.connections[0].serverUrl).toBe('https://sonarcloud.io');
      expect(capturedState.auth.connections[0].orgKey).toBe('test-org');
      expect(capturedState.auth.isAuthenticated).toBe(true);
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
    }
  });

  it('shows verification results after successful health check', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);

    try {
      await integrateClaude({
        server: 'https://sonarcloud.io',
        project: 'my-project',
        token: 'test-token',
        org: 'test-org',
      });
      const texts = getMockUiCalls()
        .filter((c) => c.method === 'text')
        .map((c) => String(c.args[0]));
      expect(texts.some((m) => m.includes('Token valid'))).toBe(true);
      expect(texts.some((m) => m.includes('Server available'))).toBe(true);
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
    }
  });

  it('shows partial verification results when some checks fail', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    const partialHealth = {
      ...CLEAN_HEALTH,
      projectAccessible: false,
      organizationAccessible: false,
      qualityProfilesAccessible: false,
      hooksInstalled: false,
      errors: ['Project not accessible'],
    };
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(partialHealth);
    const repairSpy = spyOn(repair, 'runRepair').mockResolvedValue(undefined);

    try {
      await integrateClaude({
        server: 'https://sonarcloud.io',
        project: 'my-project',
        token: 'test-token',
        org: 'test-org',
      });
      const texts = getMockUiCalls()
        .filter((c) => c.method === 'text')
        .map((c) => String(c.args[0]));
      expect(texts.some((m) => m.includes('Token valid'))).toBe(true);
      expect(texts.some((m) => m.includes('Project not accessible'))).toBe(true);
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
      repairSpy.mockRestore();
    }
  });

  it('runs repair when health check finds issues', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    const unhealthyResult = {
      ...CLEAN_HEALTH,
      hooksInstalled: false,
      errors: ['Hooks not installed'],
    };
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(unhealthyResult);
    const repairSpy = spyOn(repair, 'runRepair').mockResolvedValue(undefined);

    try {
      await integrateClaude({
        server: 'https://sonarcloud.io',
        project: 'my-project',
        token: 'test-token',
        org: 'test-org',
      });
      expect(repairSpy).toHaveBeenCalled();
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
      repairSpy.mockRestore();
    }
  });

  it('tracks hooks in state when skipHooks is false', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);
    const addInstalledHookSpy = spyOn(stateManager, 'addInstalledHook');

    try {
      await integrateClaude({
        server: 'https://sonarcloud.io',
        project: 'my-project',
        token: 'test-token',
        org: 'test-org',
      });
      expect(addInstalledHookSpy).toHaveBeenCalledWith(
        expect.anything(),
        'claude-code',
        'sonar-secrets',
        'PreToolUse',
      );
      expect(addInstalledHookSpy).toHaveBeenCalledWith(
        expect.anything(),
        'claude-code',
        'sonar-secrets',
        'UserPromptSubmit',
      );
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
      addInstalledHookSpy.mockRestore();
    }
  });

  // CLI-143: sonar-a3s agentExtension must always be project-level
  it('registers sonar-a3s agentExtension with global:false even when -g is set', async () => {
    const capturedState = getDefaultState('test');
    loadStateSpy.mockReturnValue(capturedState);
    saveStateSpy.mockImplementation(() => {});

    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);
    const a3sSpy = spyOn(SonarQubeClient.prototype, 'hasA3sEntitlement').mockResolvedValue(true);

    try {
      await integrateClaude({
        server: 'https://sonarcloud.io',
        project: 'my-project',
        token: 'test-token',
        org: 'test-org',
        global: true,
      });

      const a3sExt = capturedState.agentExtensions.find((e) => e.name === 'sonar-a3s');
      expect(a3sExt).toBeDefined();
      expect(a3sExt!.global).toBe(false);
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
      a3sSpy.mockRestore();
    }
  });
});

// ─── configuration validation errors ──────────────────────────────────────────

describe('integrateCommand: configuration validation', () => {
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let getAllCredentialsSpy: ReturnType<typeof spyOn>;
  let getTokenSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
    getAllCredentialsSpy = spyOn(keychain, 'getAllCredentials').mockResolvedValue([]);
    getTokenSpy = spyOn(auth, 'getToken').mockResolvedValue(null);
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    getAllCredentialsSpy.mockRestore();
    getTokenSpy.mockRestore();
    setMockUi(false);
  });

  it('throws when server URL cannot be determined', () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    try {
      expect(integrateClaude({ project: 'my-project' })).rejects.toThrow(
        'Server URL or organization is required. Use --server flag or --org flag for SonarQube Cloud',
      );
    } finally {
      discoverSpy.mockRestore();
    }
  });

  it('installs hooks when no project key is configured', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    const hooksSpy = spyOn(hooks, 'installHooks').mockResolvedValue(undefined);
    try {
      await integrateClaude({
        server: 'https://sonarcloud.io',
        org: 'my-org',
        nonInteractive: true,
      });
      expect(hooksSpy).toHaveBeenCalled();
    } finally {
      discoverSpy.mockRestore();
      hooksSpy.mockRestore();
    }
  });

  it('defaults to SonarQube Cloud when org is provided but no server', async () => {
    const projectInfoWithOrg = { ...FAKE_PROJECT_INFO };
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(projectInfoWithOrg);
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);
    try {
      await integrateClaude({
        project: 'my-project',
        org: 'my-org',
        token: 'test-token',
      });
      const infos = getMockUiCalls()
        .filter((c) => c.method === 'info')
        .map((c) => String(c.args[0]));
      expect(infos.some((m) => m.toLowerCase().includes('sonarqube cloud'))).toBe(true);
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
    }
  });
});

// ─── discovered configuration ────────────────────────────────────────────────

describe('integrateCommand: discovered project configuration', () => {
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
  });

  it('uses sonar-project.properties when discovered', async () => {
    const projectInfoWithProps = {
      ...FAKE_PROJECT_INFO,
      hasSonarProps: true,
      sonarPropsData: {
        hostURL: 'https://sonarcloud.io',
        projectKey: 'discovered-project',
        organization: 'discovered-org',
        projectName: 'discovered-project',
      },
    };
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(projectInfoWithProps);
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);
    try {
      await integrateClaude({ token: 'test-token' });
      const texts = getMockUiCalls()
        .filter((c) => c.method === 'text')
        .map((c) => String(c.args[0]));
      expect(texts.some((m) => m.includes('sonar-project.properties'))).toBe(true);
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
    }
  });

  it('uses .sonarlint/connectedMode.json when discovered', async () => {
    const projectInfoWithSonarLint = {
      ...FAKE_PROJECT_INFO,
      hasSonarLintConfig: true,
      sonarLintData: {
        serverURL: 'https://sonarcloud.io',
        projectKey: 'sonarlint-project',
        organization: 'sonarlint-org',
      },
    };
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(
      projectInfoWithSonarLint,
    );
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);
    try {
      await integrateClaude({ token: 'test-token' });
      const texts = getMockUiCalls()
        .filter((c) => c.method === 'text')
        .map((c) => String(c.args[0]));
      expect(texts.some((m) => m.includes('connectedMode.json'))).toBe(true);
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
    }
  });
});

// ─── global flag ──────────────────────────────────────────────────────────────

describe('integrateCommand: --global flag', () => {
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
  });

  it('exits 0 when global onboarding succeeds', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);

    try {
      await integrateClaude({
        server: 'https://sonarcloud.io',
        project: 'my-project',
        token: 'test-token',
        org: 'test-org',
        global: true,
      });
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
    }
  });

  it('completes successfully with --global and skipHooks=false', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);

    try {
      await integrateClaude({
        server: 'https://sonarcloud.io',
        project: 'my-project',
        token: 'test-token',
        org: 'test-org',
        global: true,
      });
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
    }
  });

  it('installs hooks into homedir when --global is set', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);
    const hooksSpy = spyOn(hooks, 'installHooks').mockResolvedValue(undefined);

    try {
      await integrateClaude({
        server: 'https://sonarcloud.io',
        project: 'my-project',
        token: 'test-token',
        org: 'test-org',
        global: true,
      });
      expect(hooksSpy).toHaveBeenCalledWith(FAKE_PROJECT_INFO.root, homedir(), false, 'my-project');
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
      hooksSpy.mockRestore();
    }
  });

  it('installs hooks into homedir and saves connection in non-interactive mode without token', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    const getTokenSpy = spyOn(auth, 'getToken').mockResolvedValue(null);
    const getAllCredentialsSpy = spyOn(keychain, 'getAllCredentials').mockResolvedValue([]);
    const hooksSpy = spyOn(hooks, 'installHooks').mockResolvedValue(undefined);
    const addOrUpdateConnectionSpy = spyOn(stateManager, 'addOrUpdateConnection');

    try {
      await integrateClaude({
        server: 'https://sonarcloud.io',
        nonInteractive: true,
        global: true,
      });
      expect(hooksSpy).toHaveBeenCalledWith(FAKE_PROJECT_INFO.root, homedir(), false, undefined);
      expect(addOrUpdateConnectionSpy).toHaveBeenCalledWith(
        expect.anything(),
        'https://sonarcloud.io',
        expect.any(String),
        expect.anything(),
      );
    } finally {
      discoverSpy.mockRestore();
      getTokenSpy.mockRestore();
      getAllCredentialsSpy.mockRestore();
      hooksSpy.mockRestore();
      addOrUpdateConnectionSpy.mockRestore();
    }
  });

  // CLI-148: global and project-level agentExtensions must coexist without collision.
  // Scenario: cd my-project && sonar integrate claude, then sonar integrate claude -g.
  // The project-level sonar-secrets hooks (global: false) must NOT be lost after the global run.
  it('keeps separate agentExtensions for project-level and global integrations from same dir', async () => {
    const capturedState = getDefaultState('test');
    loadStateSpy.mockReturnValue(capturedState);
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);

    try {
      // Step 1: project-level integration (sonar integrate claude)
      await integrateClaude({
        server: 'https://sonarcloud.io',
        project: 'my-project',
        token: 'test-token',
        org: 'test-org',
        global: false,
      });

      // Verify project-level secrets hooks are registered
      const projectSecretsPreTool = capturedState.agentExtensions.find(
        (e) => e.name === 'sonar-secrets' && e.hookType === 'PreToolUse' && !e.global,
      );
      const projectSecretsPrompt = capturedState.agentExtensions.find(
        (e) => e.name === 'sonar-secrets' && e.hookType === 'UserPromptSubmit' && !e.global,
      );
      expect(projectSecretsPreTool).toBeDefined();
      expect(projectSecretsPrompt).toBeDefined();

      // Step 2: global integration from same directory (sonar integrate claude -g)
      await integrateClaude({
        server: 'https://sonarcloud.io',
        project: 'my-project',
        token: 'test-token',
        org: 'test-org',
        global: true,
      });

      // Project-level secrets hooks must still be present and unmodified
      const projectSecretsPreToolAfter = capturedState.agentExtensions.find(
        (e) => e.name === 'sonar-secrets' && e.hookType === 'PreToolUse' && !e.global,
      );
      const projectSecretsPromptAfter = capturedState.agentExtensions.find(
        (e) => e.name === 'sonar-secrets' && e.hookType === 'UserPromptSubmit' && !e.global,
      );
      expect(projectSecretsPreToolAfter).toBeDefined();
      expect(projectSecretsPromptAfter).toBeDefined();

      // Global secrets hooks must also be present
      const globalSecretsPreTool = capturedState.agentExtensions.find(
        (e) => e.name === 'sonar-secrets' && e.hookType === 'PreToolUse' && e.global,
      );
      const globalSecretsPrompt = capturedState.agentExtensions.find(
        (e) => e.name === 'sonar-secrets' && e.hookType === 'UserPromptSubmit' && e.global,
      );
      expect(globalSecretsPreTool).toBeDefined();
      expect(globalSecretsPrompt).toBeDefined();
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
    }
  });
});

// ─── no token path ────────────────────────────────────────────────────────────

describe('integrateCommand: no token available', () => {
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let getAllCredentialsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
    getAllCredentialsSpy = spyOn(keychain, 'getAllCredentials').mockResolvedValue([]);
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    getAllCredentialsSpy.mockRestore();
    setMockUi(false);
  });

  it('warns when no token found and triggers repair', () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    const getTokenSpy = spyOn(auth, 'getToken').mockResolvedValue(null);
    const repairSpy = spyOn(repair, 'runRepair').mockRejectedValue(new Error('repair failed'));

    try {
      expect(
        integrateClaude({
          server: 'https://sonarcloud.io',
          project: 'my-project',
        }),
      ).rejects.toThrow(new Error('repair failed'));
      const warns = getMockUiCalls()
        .filter((c) => c.method === 'warn')
        .map((c) => String(c.args[0]));
      expect(warns.some((m) => m.toLowerCase().includes('token'))).toBe(true);
    } finally {
      discoverSpy.mockRestore();
      getTokenSpy.mockRestore();
      repairSpy.mockRestore();
    }
  });
});
