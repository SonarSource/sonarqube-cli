// Unit tests for sonar onboard-agent command

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { onboardAgentCommand } from '../../src/commands/onboard-agent.js';
import * as discovery from '../../src/bootstrap/discovery.js';
import * as health from '../../src/bootstrap/health.js';
import { setMockUi } from '../../src/ui';

describe('onboardAgentCommand', () => {
  let mockExit: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
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

  it('exits 1 when --hook-type is invalid', async () => {
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue({
      root: '/fake/project',
      name: 'fake-project',
      isGitRepo: true,
      gitRemote: '',
      hasSonarProps: false,
      sonarPropsData: null,
      hasSonarLintConfig: false,
      sonarLintData: null,
    });

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
    const discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue({
      root: '/fake/project',
      name: 'fake-project',
      isGitRepo: true,
      gitRemote: '',
      hasSonarProps: false,
      sonarPropsData: null,
      hasSonarLintConfig: false,
      sonarLintData: null,
    });

    const healthSpy = spyOn(health, 'runHealthChecks').mockResolvedValue({
      tokenValid: true,
      serverAvailable: true,
      projectAccessible: true,
      organizationAccessible: true,
      qualityProfilesAccessible: true,
      hooksInstalled: true,
      errors: [],
    });

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
});
