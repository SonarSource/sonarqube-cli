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

// Every collaborator below is spied on its real module namespace (never `mock.module`):
// `mock.module` replaces the WHOLE module for the entire test process (bun test --parallel
// interleaves files rather than isolating module registries per file), so a partial-export
// replacement of a widely-imported module (auth-resolver, project-info, stdin, project-uuid,
// context-augmentation — every one of these has other exports used by concurrently-running
// specs) would silently strip those exports out from under them. `spyOn` on a real import
// swaps only the one function and restores the real one on `mockRestore()`.
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

import * as stdin from '@/commands/hook/stdin.ts';
import * as commonContextAugmentation from '@/commands/integrate/_common/context-augmentation.ts';
import * as authResolver from '@/core/auth/auth-resolver.ts';
import * as installContextAugmentation from '@/core/host/install/context-augmentation.ts';
import * as projectInfo from '@/core/project-info.ts';
import { SonarQubeClient } from '@/core/server/client.ts';
import * as projectUuid from '@/core/telemetry/project-uuid.ts';

const AUTH = { serverUrl: 'https://sonarcloud.io', token: 'tok', orgKey: 'my-org' };
const PROJECT_KEY = 'my-project';

describe('handleAgentSessionStart', () => {
  let writeSpy: ReturnType<typeof mock>;
  const originalWrite = process.stdout.write.bind(process.stdout);
  let spies: ReturnType<typeof spyOn>[] = [];

  function track<T extends ReturnType<typeof spyOn>>(spy: T): T {
    spies.push(spy);
    return spy;
  }

  afterEach(() => {
    process.stdout.write = originalWrite;
    for (const spy of spies) spy.mockRestore();
    spies = [];
  });

  function spyOnStdout(): void {
    writeSpy = mock(() => true);
    process.stdout.write = writeSpy;
  }

  function stubStdin(payload: Record<string, unknown>): void {
    track(spyOn(stdin, 'readStdinJsonWithRaw')).mockResolvedValue({
      raw: JSON.stringify(payload),
      parsed: payload,
    });
  }

  function stubStdinRejects(): void {
    track(spyOn(stdin, 'readStdinJsonWithRaw')).mockRejectedValue(
      new Error('stdin read timed out'),
    );
  }

  function stubProjectDiscovery(matched: boolean): ReturnType<typeof spyOn> {
    return track(
      spyOn(projectInfo, 'discoverProject').mockResolvedValue(
        matched
          ? { projectRoot: '/repo', projectKey: PROJECT_KEY, configSources: [] }
          : { projectRoot: '/repo', configSources: [] },
      ),
    );
  }

  function stubEntitlement(result: { status: string } | Error): void {
    const spy = track(spyOn(SonarQubeClient.prototype, 'hasVortexEntitlement'));
    if (result instanceof Error) {
      spy.mockRejectedValue(result);
    } else {
      spy.mockResolvedValue(result as never);
    }
  }

  function stubCommonRuntime(overrides: {
    auth?: typeof AUTH | null;
    binaryPath?: string | null;
    contextText?: string | null;
  }): { noteProjectSpy: ReturnType<typeof spyOn>; captureSpy: ReturnType<typeof spyOn> } {
    const noteProjectSpy = track(spyOn(projectUuid, 'noteProject')).mockReturnValue(undefined);
    track(spyOn(authResolver, 'resolveAuth')).mockResolvedValue(
      (overrides.auth === undefined ? AUTH : overrides.auth) as never,
    );
    track(
      spyOn(installContextAugmentation, 'resolveContextAugmentationBinaryPath'),
    ).mockReturnValue(
      overrides.binaryPath === undefined ? '/bin/sonar-context-augmentation' : overrides.binaryPath,
    );
    const captureSpy = track(
      spyOn(commonContextAugmentation, 'resolveContextAugmentationSessionStartText'),
    ).mockResolvedValue(
      overrides.contextText === undefined ? 'Vortex context text' : overrides.contextText,
    );

    return { noteProjectSpy, captureSpy };
  }

  it('returns null agentSessionId and writes nothing on unparseable stdin', async () => {
    stubStdinRejects();
    spyOnStdout();

    const { handleAgentSessionStart } = await import('@/commands/hook/agent-session-start.ts');
    const result = await handleAgentSessionStart('SessionStart');

    expect(result).toEqual({ agentSessionId: null });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('writes nothing when there is no resolved auth, without ever calling discoverProject', async () => {
    stubStdin({ session_id: 's1', cwd: '/repo' });
    const discoverSpy = stubProjectDiscovery(true);
    stubCommonRuntime({ auth: null });
    spyOnStdout();

    const { handleAgentSessionStart } = await import('@/commands/hook/agent-session-start.ts');
    const result = await handleAgentSessionStart('SessionStart');

    expect(result).toEqual({ agentSessionId: 's1' });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(discoverSpy).not.toHaveBeenCalled();
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

  it('resolves the project with the server-touching git-remote binding disabled', async () => {
    // payload.cwd falls back to process.cwd() via existsSync() when it doesn't exist on disk,
    // so use a real, existing directory here to assert exactly what gets passed through.
    stubStdin({ session_id: 's1', cwd: process.cwd() });
    const discoverSpy = stubProjectDiscovery(true);
    stubCommonRuntime({});
    stubEntitlement({ status: 'enabled' });
    spyOnStdout();

    const { handleAgentSessionStart } = await import('@/commands/hook/agent-session-start.ts');
    await handleAgentSessionStart('SessionStart');

    expect(discoverSpy).toHaveBeenCalledWith(
      process.cwd(),
      expect.objectContaining({ tryGitRemoteBinding: false }),
    );
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

  it('writes the Claude SessionStart hook envelope on success, notes the project, and passes a capture deadline', async () => {
    stubStdin({ session_id: 's1', cwd: '/repo' });
    stubProjectDiscovery(true);
    const { noteProjectSpy, captureSpy } = stubCommonRuntime({});
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
    expect(noteProjectSpy).toHaveBeenCalledWith(AUTH, PROJECT_KEY);
    expect(captureSpy).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
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
