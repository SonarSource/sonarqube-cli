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

import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { SonarQubeClient } from '@/core/server/client.ts';

// `mock.module` replaces a module for the whole test process (bun test --parallel interleaves
// test files within the same process rather than isolating module registries per file), so
// every module this file mocks with a partial implementation must be restored to its real one
// in `afterAll` — otherwise other concurrently-running test files silently inherit our last
// mock instead of the real module. Vortex entitlement is deliberately NOT mocked this way:
// it's exercised via `spyOn(SonarQubeClient.prototype, 'hasVortexEntitlement')` instead (the
// same pattern integrate.test.ts uses), since that module is exercised by many other specs.
const realModules = await Promise.all([
  import('@/commands/hook/stdin.ts'),
  import('@/core/auth/auth-resolver.ts'),
  import('@/core/project-info.ts'),
  import('@/core/host/install/context-augmentation.ts'),
  import('@/commands/integrate/_common/context-augmentation.ts'),
  import('@/core/telemetry/project-uuid.ts'),
] as const);
const [
  realStdin,
  realAuthResolver,
  realProjectInfo,
  realInstallContextAugmentation,
  realCommonContextAugmentation,
  realProjectUuid,
] = realModules;

afterAll(() => {
  void mock.module('@/commands/hook/stdin.ts', () => realStdin);
  void mock.module('@/core/auth/auth-resolver.ts', () => realAuthResolver);
  void mock.module('@/core/project-info.ts', () => realProjectInfo);
  void mock.module(
    '@/core/host/install/context-augmentation.ts',
    () => realInstallContextAugmentation,
  );
  void mock.module(
    '@/commands/integrate/_common/context-augmentation.ts',
    () => realCommonContextAugmentation,
  );
  void mock.module('@/core/telemetry/project-uuid.ts', () => realProjectUuid);
});

const AUTH = { serverUrl: 'https://sonarcloud.io', token: 'tok', orgKey: 'my-org' };
const PROJECT_KEY = 'my-project';

function stubStdin(payload: Record<string, unknown>): void {
  void mock.module('@/commands/hook/stdin.ts', () => ({
    readStdinJsonWithRaw: mock(() =>
      Promise.resolve({ raw: JSON.stringify(payload), parsed: payload }),
    ),
  }));
}

function stubProjectDiscovery(matched: boolean): void {
  void mock.module('@/core/project-info.ts', () => ({
    discoverProject: mock(() =>
      Promise.resolve(
        matched
          ? { projectRoot: '/repo', projectKey: PROJECT_KEY, configSources: [] }
          : { projectRoot: '/repo', configSources: [] },
      ),
    ),
  }));
}

function stubCommonRuntime(overrides: {
  auth?: typeof AUTH | null;
  binaryPath?: string | null;
  contextText?: string | null;
}): { noteProjectMock: ReturnType<typeof mock>; captureMock: ReturnType<typeof mock> } {
  const noteProjectMock = mock(() => undefined);
  void mock.module('@/core/telemetry/project-uuid.ts', () => ({ noteProject: noteProjectMock }));

  void mock.module('@/core/auth/auth-resolver.ts', () => ({
    resolveAuth: mock(() => Promise.resolve(overrides.auth === undefined ? AUTH : overrides.auth)),
  }));
  void mock.module('@/core/host/install/context-augmentation.ts', () => ({
    resolveContextAugmentationBinaryPath: mock(() =>
      overrides.binaryPath === undefined ? '/bin/sonar-context-augmentation' : overrides.binaryPath,
    ),
  }));
  const captureMock = mock(() =>
    Promise.resolve(
      overrides.contextText === undefined ? 'Vortex context text' : overrides.contextText,
    ),
  );
  void mock.module('@/commands/integrate/_common/context-augmentation.ts', () => ({
    resolveContextAugmentationSessionStartText: captureMock,
  }));

  return { noteProjectMock, captureMock };
}

describe('handleAgentSessionStart', () => {
  let writeSpy: ReturnType<typeof mock>;
  const originalWrite = process.stdout.write.bind(process.stdout);
  // Same mocking primitive integrate.test.ts uses for Vortex entitlement, so this file
  // never needs to (and must not) replace the whole @/core/vortex/entitlement.ts module.
  let hasVortexEntitlementSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    process.stdout.write = originalWrite;
    hasVortexEntitlementSpy?.mockRestore();
  });

  function spyOnStdout(): void {
    writeSpy = mock(() => true);
    process.stdout.write = writeSpy;
  }

  function stubEntitlement(result: { status: string } | Error): void {
    hasVortexEntitlementSpy = spyOn(SonarQubeClient.prototype, 'hasVortexEntitlement');
    if (result instanceof Error) {
      hasVortexEntitlementSpy.mockRejectedValue(result);
    } else {
      hasVortexEntitlementSpy.mockResolvedValue(result);
    }
  }

  it('returns null agentSessionId and writes nothing on unparseable stdin', async () => {
    void mock.module('@/commands/hook/stdin.ts', () => ({
      readStdinJsonWithRaw: mock(() => Promise.reject(new Error('stdin read timed out'))),
    }));
    spyOnStdout();

    const { handleAgentSessionStart } = await import('@/commands/hook/agent-session-start.ts');
    const result = await handleAgentSessionStart('SessionStart');

    expect(result).toEqual({ agentSessionId: null });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('writes nothing when there is no resolved auth', async () => {
    stubStdin({ session_id: 's1', cwd: '/repo' });
    stubProjectDiscovery(true);
    stubCommonRuntime({ auth: null });
    spyOnStdout();

    const { handleAgentSessionStart } = await import('@/commands/hook/agent-session-start.ts');
    const result = await handleAgentSessionStart('SessionStart');

    expect(result).toEqual({ agentSessionId: 's1' });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('writes nothing when no project resolves for the directory', async () => {
    stubStdin({ session_id: 's1', cwd: '/repo' });
    stubProjectDiscovery(false);
    stubCommonRuntime({});
    spyOnStdout();

    const { handleAgentSessionStart } = await import('@/commands/hook/agent-session-start.ts');
    const result = await handleAgentSessionStart('SessionStart');

    expect(result).toEqual({ agentSessionId: 's1' });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('writes nothing when Vortex entitlement is not enabled', async () => {
    stubStdin({ session_id: 's1', cwd: '/repo' });
    stubProjectDiscovery(true);
    stubCommonRuntime({});
    stubEntitlement({ status: 'not_entitled' });
    spyOnStdout();

    const { handleAgentSessionStart } = await import('@/commands/hook/agent-session-start.ts');
    const result = await handleAgentSessionStart('SessionStart');

    expect(result).toEqual({ agentSessionId: 's1' });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('writes nothing when the CAG binary is not installed', async () => {
    stubStdin({ session_id: 's1', cwd: '/repo' });
    stubProjectDiscovery(true);
    stubCommonRuntime({ binaryPath: null });
    stubEntitlement({ status: 'enabled' });
    spyOnStdout();

    const { handleAgentSessionStart } = await import('@/commands/hook/agent-session-start.ts');
    const result = await handleAgentSessionStart('SessionStart');

    expect(result).toEqual({ agentSessionId: 's1' });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('writes nothing when CAG produces no context text', async () => {
    stubStdin({ session_id: 's1', cwd: '/repo' });
    stubProjectDiscovery(true);
    stubCommonRuntime({ contextText: null });
    stubEntitlement({ status: 'enabled' });
    spyOnStdout();

    const { handleAgentSessionStart } = await import('@/commands/hook/agent-session-start.ts');
    const result = await handleAgentSessionStart('SessionStart');

    expect(result).toEqual({ agentSessionId: 's1' });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('writes the Claude SessionStart hook envelope on success and notes the project', async () => {
    stubStdin({ session_id: 's1', cwd: '/repo' });
    stubProjectDiscovery(true);
    const { noteProjectMock } = stubCommonRuntime({});
    stubEntitlement({ status: 'enabled' });
    spyOnStdout();

    const { handleAgentSessionStart } = await import('@/commands/hook/agent-session-start.ts');
    const result = await handleAgentSessionStart('SessionStart');

    expect(result).toEqual({ agentSessionId: 's1' });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const written = JSON.parse((writeSpy.mock.calls[0][0] as string).trim());
    expect(written).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'Vortex context text',
      },
    });
    expect(noteProjectMock).toHaveBeenCalledWith(AUTH, PROJECT_KEY);
  });

  it('uses SubagentStart as the hookEventName when invoked for that event', async () => {
    stubStdin({ session_id: 's1', cwd: '/repo' });
    stubProjectDiscovery(true);
    stubCommonRuntime({});
    stubEntitlement({ status: 'enabled' });
    spyOnStdout();

    const { handleAgentSessionStart } = await import('@/commands/hook/agent-session-start.ts');
    await handleAgentSessionStart('SubagentStart');

    const written = JSON.parse((writeSpy.mock.calls[0][0] as string).trim());
    expect(written.hookSpecificOutput.hookEventName).toBe('SubagentStart');
  });

  it('fails open and writes nothing when an unexpected error is thrown mid-flow', async () => {
    stubStdin({ session_id: 's1', cwd: '/repo' });
    stubProjectDiscovery(true);
    stubCommonRuntime({});
    // resolveVortexEntitlement isn't wrapped in its own .catch() inside the handler,
    // so a rejection here must be caught by the handler's outer try/catch instead.
    stubEntitlement(new Error('boom'));
    spyOnStdout();

    const { handleAgentSessionStart } = await import('@/commands/hook/agent-session-start.ts');
    const result = await handleAgentSessionStart('SessionStart');

    expect(result).toEqual({ agentSessionId: 's1' });
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
