// Unit tests for sonar onboard-agent command

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { onboardAgentCommand } from '../../src/commands/onboard-agent.js';
import * as discovery from '../../src/bootstrap/discovery.js';
import * as health from '../../src/bootstrap/health.js';
import * as stateManager from '../../src/lib/state-manager.js';
import { getDefaultState } from '../../src/lib/state.js';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../src/ui';
import { ENV_TOKEN, ENV_SERVER } from '../../src/lib/auth-resolver.js';

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

describe('onboardAgentCommand: validateAgent', () => {
  let mockExit: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    mockExit.mockRestore();
    setMockUi(false);
  });

  it('exits 1 when unsupported agent is provided', async () => {
    await onboardAgentCommand('gemini', {});
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 for any unknown agent name', async () => {
    await onboardAgentCommand('copilot', {});
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('error message mentions the unsupported agent name', async () => {
    await onboardAgentCommand('gemini', {});
    const errors = getMockUiCalls().filter(c => c.method === 'error').map(c => String(c.args[0]));
    expect(errors.some(m => m.includes('gemini'))).toBe(true);
  });

  it('error message lists supported agents', async () => {
    await onboardAgentCommand('codex', {});
    const errors = getMockUiCalls().filter(c => c.method === 'error').map(c => String(c.args[0]));
    expect(errors.some(m => m.includes('claude'))).toBe(true);
  });
});

// ─── env var auth warning ─────────────────────────────────────────────────────

describe('onboardAgentCommand: env var auth', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let discoverSpy: ReturnType<typeof spyOn>;
  let healthSpy: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
    delete process.env[ENV_TOKEN];
    delete process.env[ENV_SERVER];
  });

  afterEach(() => {
    mockExit.mockRestore();
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
    await onboardAgentCommand('claude', {
      server: 'https://sonarcloud.io',
      project: 'my-project',
      token: 'squ_cli_token',
      org: 'my-org',
      skipHooks: true,
    });
    const warns = getMockUiCalls().filter(c => c.method === 'warn').map(c => String(c.args[0]));
    expect(warns.some(m => m.includes(ENV_SERVER))).toBe(true);
  });

  it('warns when only SONAR_CLI_SERVER is set (partial env vars)', async () => {
    process.env[ENV_SERVER] = 'https://sonarcloud.io';
    await onboardAgentCommand('claude', {
      server: 'https://sonarcloud.io',
      project: 'my-project',
      token: 'squ_cli_token',
      org: 'my-org',
      skipHooks: true,
    });
    const warns = getMockUiCalls().filter(c => c.method === 'warn').map(c => String(c.args[0]));
    expect(warns.some(m => m.includes(ENV_TOKEN))).toBe(true);
  });
});

// ─── full flow ────────────────────────────────────────────────────────────────

describe('onboardAgentCommand: full flow', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
  });

  afterEach(() => {
    mockExit.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
  });

  it('exits 1 when --hook-type is invalid', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);

    try {
      await onboardAgentCommand('claude', {
        server: 'https://sonarcloud.io',
        project: 'my-project',
        token: 'test-token',
        org: 'test-org',
        hookType: 'invalid-type',
        skipHooks: true,
      });
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      discoverSpy.mockRestore();
    }
  });

  it('exits 0 when onboarding succeeds with all checks passing', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);

    try {
      await onboardAgentCommand('claude', {
        server: 'https://sonarcloud.io',
        project: 'my-project',
        token: 'test-token',
        org: 'test-org',
        skipHooks: true,
      });
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
    }
  });

  it('shows verification results after successful health check', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);

    try {
      await onboardAgentCommand('claude', {
        server: 'https://sonarcloud.io',
        project: 'my-project',
        token: 'test-token',
        org: 'test-org',
        skipHooks: true,
      });
      const texts = getMockUiCalls().filter(c => c.method === 'text').map(c => String(c.args[0]));
      expect(texts.some(m => m.includes('Token valid'))).toBe(true);
      expect(texts.some(m => m.includes('Server available'))).toBe(true);
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
    }
  });
});
