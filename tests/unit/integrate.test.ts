// Unit tests for sonar integrate command

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { integrateCommand } from "../../src/commands/integrate.js";
import * as discovery from '../../src/bootstrap/discovery.js';
import * as health from '../../src/bootstrap/health.js';
import * as repair from '../../src/bootstrap/repair.js';
import * as auth from '../../src/bootstrap/auth.js';
import * as keychain from '../../src/lib/keychain.js';
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

describe('integrateCommand: validateAgent', () => {
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
    await integrateCommand('gemini', {});
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 for any unknown agent name', async () => {
    await integrateCommand('copilot', {});
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('error message mentions the unsupported agent name', async () => {
    await integrateCommand('gemini', {});
    const errors = getMockUiCalls().filter(c => c.method === 'error').map(c => String(c.args[0]));
    expect(errors.some(m => m.includes('gemini'))).toBe(true);
  });

  it('error message lists supported agents', async () => {
    await integrateCommand('codex', {});
    const errors = getMockUiCalls().filter(c => c.method === 'error').map(c => String(c.args[0]));
    expect(errors.some(m => m.includes('claude'))).toBe(true);
  });
});

// ─── env var auth warning ─────────────────────────────────────────────────────

describe('integrateCommand: env var auth', () => {
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
    await integrateCommand('claude', {
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
    await integrateCommand('claude', {
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

describe('integrateCommand: full flow', () => {
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

  it('exits 0 when onboarding succeeds with all checks passing', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);

    try {
      await integrateCommand('claude', {
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
      await integrateCommand('claude', {
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
      await integrateCommand('claude', {
        server: 'https://sonarcloud.io',
        project: 'my-project',
        token: 'test-token',
        org: 'test-org',
        skipHooks: true,
      });
      const texts = getMockUiCalls().filter(c => c.method === 'text').map(c => String(c.args[0]));
      expect(texts.some(m => m.includes('Token valid'))).toBe(true);
      expect(texts.some(m => m.includes('Project not accessible'))).toBe(true);
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
      await integrateCommand('claude', {
        server: 'https://sonarcloud.io',
        project: 'my-project',
        token: 'test-token',
        org: 'test-org',
        skipHooks: true,
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

    try {
      await integrateCommand('claude', {
        server: 'https://sonarcloud.io',
        project: 'my-project',
        token: 'test-token',
        org: 'test-org',
        skipHooks: false,
      });
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
    }
  });
});

// ─── configuration validation errors ──────────────────────────────────────────

describe('integrateCommand: configuration validation', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let getAllCredentialsSpy: ReturnType<typeof spyOn>;
  let getTokenSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
    getAllCredentialsSpy = spyOn(keychain, 'getAllCredentials').mockResolvedValue([]);
    getTokenSpy = spyOn(auth, 'getToken').mockResolvedValue(null);
  });

  afterEach(() => {
    mockExit.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    getAllCredentialsSpy.mockRestore();
    getTokenSpy.mockRestore();
    setMockUi(false);
  });

  it('exits 1 when server URL cannot be determined', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    try {
      await integrateCommand('claude', { project: 'my-project' });
      expect(mockExit).toHaveBeenCalledWith(1);
      const errors = getMockUiCalls().filter(c => c.method === 'error').map(c => String(c.args[0]));
      expect(errors.some(m => m.includes('Server URL'))).toBe(true);
    } finally {
      discoverSpy.mockRestore();
    }
  });

  it('exits 1 when project key cannot be determined', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    try {
      await integrateCommand('claude', { server: 'https://sonarcloud.io' });
      expect(mockExit).toHaveBeenCalledWith(1);
      const errors = getMockUiCalls().filter(c => c.method === 'error').map(c => String(c.args[0]));
      expect(errors.some(m => m.includes('Project key'))).toBe(true);
    } finally {
      discoverSpy.mockRestore();
    }
  });

  it('defaults to SonarCloud when org is provided but no server', async () => {
    const projectInfoWithOrg = { ...FAKE_PROJECT_INFO };
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(projectInfoWithOrg);
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);
    try {
      await integrateCommand('claude', {
        project: 'my-project',
        org: 'my-org',
        token: 'test-token',
        skipHooks: true,
      });
      const infos = getMockUiCalls().filter(c => c.method === 'info').map(c => String(c.args[0]));
      expect(infos.some(m => m.toLowerCase().includes('sonarcloud'))).toBe(true);
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
    }
  });
});

// ─── discovered configuration ────────────────────────────────────────────────

describe('integrateCommand: discovered project configuration', () => {
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

  it('uses sonar-project.properties when discovered', async () => {
    const projectInfoWithProps = {
      ...FAKE_PROJECT_INFO,
      hasSonarProps: true,
      sonarPropsData: {
        hostURL: 'https://sonarcloud.io',
        projectKey: 'discovered-project',
        organization: 'discovered-org',
      },
    };
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(projectInfoWithProps);
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);
    try {
      await integrateCommand('claude', { token: 'test-token', skipHooks: true });
      const texts = getMockUiCalls().filter(c => c.method === 'text').map(c => String(c.args[0]));
      expect(texts.some(m => m.includes('sonar-project.properties'))).toBe(true);
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
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(projectInfoWithSonarLint);
    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue(CLEAN_HEALTH);
    try {
      await integrateCommand('claude', { token: 'test-token', skipHooks: true });
      const texts = getMockUiCalls().filter(c => c.method === 'text').map(c => String(c.args[0]));
      expect(texts.some(m => m.includes('connectedMode.json'))).toBe(true);
    } finally {
      discoverSpy.mockRestore();
      healthSpy.mockRestore();
    }
  });
});

// ─── no token path ────────────────────────────────────────────────────────────

describe('integrateCommand: no token available', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let getAllCredentialsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
    getAllCredentialsSpy = spyOn(keychain, 'getAllCredentials').mockResolvedValue([]);
  });

  afterEach(() => {
    mockExit.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    getAllCredentialsSpy.mockRestore();
    setMockUi(false);
  });

  it('warns when no token found and triggers repair', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(FAKE_PROJECT_INFO);
    const getTokenSpy = spyOn(auth, 'getToken').mockResolvedValue(null);
    const repairSpy = spyOn(repair, 'runRepair').mockRejectedValue(new Error('repair failed'));

    try {
      await integrateCommand('claude', {
        server: 'https://sonarcloud.io',
        project: 'my-project',
        skipHooks: true,
      });
      const warns = getMockUiCalls().filter(c => c.method === 'warn').map(c => String(c.args[0]));
      expect(warns.some(m => m.toLowerCase().includes('token'))).toBe(true);
    } finally {
      discoverSpy.mockRestore();
      getTokenSpy.mockRestore();
      repairSpy.mockRestore();
    }
  });
});
