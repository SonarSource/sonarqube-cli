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

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { authStatus } from '@/commands/auth/status.ts';
import { AuthResolver, ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { createCliRuntime } from '@/core/commands/cli-runtime.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import * as keychain from '@/core/host/keychain.ts';
import * as projectInfo from '@/core/project-info.ts';
import { okAsync } from '@/core/result.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

describe('authStatus with FakeConsole', () => {
  const restorers: Array<() => void> = [];

  afterEach(() => {
    restorers.splice(0).forEach((restore) => restore());
  });

  function envAuth(): ResolvedAuth {
    return new ResolvedAuth({
      connectionType: 'cloud',
      orgKey: 'sonarsource',
      serverUrl: 'https://sonarcloud.io',
      source: 'env',
      token: 'a-token',
    });
  }

  function rendered(fake: FakeConsole): string {
    const parts: string[] = [];
    for (const call of fake.calls) {
      for (const arg of call.args) {
        for (const value of Array.isArray(arg) ? (arg as unknown[]) : [arg]) {
          if (typeof value === 'string') {
            parts.push(value);
          }
        }
      }
    }
    return parts.join('\n');
  }

  function contextFor(auth: ResolvedAuth): { ctx: CommandInvocationContext; fake: FakeConsole } {
    const authResolver = new AuthResolver();
    spyOn(authResolver, 'resolveAuth').mockReturnValue(okAsync(auth));
    const fake = new FakeConsole();
    return {
      ctx: new CommandInvocationContext(fake, undefined, createCliRuntime({ authResolver })),
      fake,
    };
  }

  // `sonar auth status` answers a global question while `sonar context` resolves credentials
  // per project, so the two can disagree. When they do, saying only "Connected" tells the user
  // their setup is fine moments before another command tells them it is not, which reads as a
  // broken tool and sends people hunting in the wrong place.
  it('warns when the project records a connection the current credentials do not match', async () => {
    const discoverProjectSpy = spyOn(projectInfo, 'discoverProject').mockResolvedValue({
      configSources: [],
      organization: 'another-org',
      projectKey: 'a-project',
      projectRoot: process.cwd(),
      serverUrl: 'https://regional.sonarcloud.io',
    });
    restorers.push(() => discoverProjectSpy.mockRestore());

    const { ctx, fake } = contextFor(envAuth());
    await authStatus(ctx);

    const output = rendered(fake);
    expect(output).toContain('Connected');
    expect(output).toContain('This project expects a different connection');
    expect(output).toContain('https://regional.sonarcloud.io');
    expect(output).toContain('another-org');
  });

  it('says nothing extra when the project records the same connection', async () => {
    const discoverProjectSpy = spyOn(projectInfo, 'discoverProject').mockResolvedValue({
      configSources: [],
      organization: 'sonarsource',
      projectKey: 'a-project',
      projectRoot: process.cwd(),
      serverUrl: 'https://sonarcloud.io',
    });
    restorers.push(() => discoverProjectSpy.mockRestore());

    const { ctx, fake } = contextFor(envAuth());
    await authStatus(ctx);

    expect(rendered(fake)).not.toContain('This project expects a different connection');
  });

  it('uses the current organization when the project only records the current server', async () => {
    const discoverProjectSpy = spyOn(projectInfo, 'discoverProject').mockResolvedValue({
      configSources: [],
      organization: undefined,
      projectKey: 'a-project',
      projectRoot: process.cwd(),
      serverUrl: 'https://sonarcloud.io',
    });
    restorers.push(() => discoverProjectSpy.mockRestore());

    const { ctx, fake } = contextFor(envAuth());
    await authStatus(ctx);

    expect(rendered(fake)).not.toContain('This project expects a different connection');
  });

  it('uses the current server when the project only records a different organization', async () => {
    const discoverProjectSpy = spyOn(projectInfo, 'discoverProject').mockResolvedValue({
      configSources: [],
      organization: 'another-org',
      projectKey: 'a-project',
      projectRoot: process.cwd(),
      serverUrl: undefined,
    });
    restorers.push(() => discoverProjectSpy.mockRestore());

    const { ctx, fake } = contextFor(envAuth());
    await authStatus(ctx);

    const output = rendered(fake);
    expect(output).toContain('This project expects a different connection');
    expect(output).toContain('https://sonarcloud.io');
    expect(output).toContain('another-org');
  });

  it('does not warn when the recorded connection has a stored token', async () => {
    const discoverProjectSpy = spyOn(projectInfo, 'discoverProject').mockResolvedValue({
      configSources: [],
      organization: 'another-org',
      projectKey: 'a-project',
      projectRoot: process.cwd(),
      serverUrl: 'https://regional.sonarcloud.io',
    });
    const getTokenSpy = spyOn(keychain, 'getToken').mockResolvedValue('stored-token');
    restorers.push(
      () => discoverProjectSpy.mockRestore(),
      () => getTokenSpy.mockRestore(),
    );

    const { ctx, fake } = contextFor(envAuth());
    await authStatus(ctx);

    expect(rendered(fake)).not.toContain('This project expects a different connection');
    expect(getTokenSpy).toHaveBeenCalledWith('https://regional.sonarcloud.io', 'another-org');
  });

  // Reporting must not become a reason to fail. Discovery reads the filesystem and can throw
  // for reasons that have nothing to do with authentication.
  it('still reports the connection when project discovery throws', async () => {
    const discoverProjectSpy = spyOn(projectInfo, 'discoverProject').mockRejectedValue(
      new Error('discovery exploded'),
    );
    restorers.push(() => discoverProjectSpy.mockRestore());

    const { ctx, fake } = contextFor(envAuth());
    await authStatus(ctx);

    const output = rendered(fake);
    expect(output).toContain('Connected');
    expect(output).not.toContain('This project expects a different connection');
  });

  it('prints "No saved connection" through ctx.console when nothing is stored', async () => {
    const authResolver = new AuthResolver();
    spyOn(authResolver, 'resolveAuth').mockReturnValue(okAsync(null));
    const loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(
      getDefaultState('1.0.0'),
    );

    const fake = new FakeConsole();
    const ctx = new CommandInvocationContext(fake, undefined, createCliRuntime({ authResolver }));

    try {
      await authStatus(ctx);
      expect.unreachable('authStatus should reject when nothing is stored');
    } catch (err) {
      expect(err).toBeInstanceOf(CommandFailedError);
    }
    expect(fake.findCall('print', 'No saved connection')).toBeDefined();
    loadStateSpy.mockRestore();
  });
});
