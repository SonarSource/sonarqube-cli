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

import { describe, expect, it, spyOn } from 'bun:test';

import { authStatus } from '@/commands/auth/status.ts';
import { AuthResolver, ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import * as token from '@/core/auth/token.ts';
import { createCliRuntime } from '@/core/commands/cli-runtime.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import * as projectInfo from '@/core/project-info.ts';
import { okAsync } from '@/core/result.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

describe('authStatus with FakeConsole', () => {
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
    spyOn(projectInfo, 'discoverProject').mockResolvedValue({
      configSources: [],
      organization: 'another-org',
      projectKey: 'a-project',
      projectRoot: process.cwd(),
      serverUrl: 'https://regional.sonarcloud.io',
    });

    const { ctx, fake } = contextFor(envAuth());
    await authStatus(ctx);

    const output = rendered(fake);
    expect(output).toContain('Connected');
    expect(output).toContain('This project expects a different connection');
    expect(output).toContain('https://regional.sonarcloud.io');
    expect(output).toContain('another-org');
  });

  it('says nothing extra when the project records the same connection', async () => {
    spyOn(projectInfo, 'discoverProject').mockResolvedValue({
      configSources: [],
      organization: 'sonarsource',
      projectKey: 'a-project',
      projectRoot: process.cwd(),
      serverUrl: 'https://sonarcloud.io',
    });

    const { ctx, fake } = contextFor(envAuth());
    await authStatus(ctx);

    expect(rendered(fake)).not.toContain('This project expects a different connection');
  });

  // Reporting must not become a reason to fail. Discovery reads the filesystem and can throw
  // for reasons that have nothing to do with authentication.
  it('still reports the connection when project discovery throws', async () => {
    spyOn(projectInfo, 'discoverProject').mockRejectedValue(new Error('discovery exploded'));

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
      await authStatus({}, ctx);
      expect.unreachable('authStatus should reject when nothing is stored');
    } catch (err) {
      expect(err).toBeInstanceOf(CommandFailedError);
    }
    expect(fake.findCall('print', 'No saved connection')).toBeDefined();
    loadStateSpy.mockRestore();
  });

  it('rejects an invalid --format value before resolving auth', async () => {
    const authResolver = new AuthResolver();
    const resolveAuthSpy = spyOn(authResolver, 'resolveAuth');
    const fake = new FakeConsole();
    const ctx = new CommandInvocationContext(fake, undefined, createCliRuntime({ authResolver }));

    try {
      await authStatus({ format: 'xml' }, ctx);
      expect.unreachable('authStatus should reject an invalid format');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidOptionError);
      expect((err as Error).message).toBe("Invalid format: 'xml'. Must be one of: text, json");
    }
    expect(resolveAuthSpy).not.toHaveBeenCalled();
  });

  it('prints a JSON payload when --format json and connected', async () => {
    const auth = new ResolvedAuth({
      token: 'test-token',
      serverUrl: 'https://sonar.example.com',
      connectionType: 'on-premise',
      source: 'state' as const,
    });
    const authResolver = new AuthResolver();
    spyOn(authResolver, 'resolveAuth').mockReturnValue(okAsync(auth));
    const checkTokenStatusSpy = spyOn(token, 'checkTokenStatus').mockResolvedValue({
      status: 'valid',
    });

    const fake = new FakeConsole();
    const ctx = new CommandInvocationContext(fake, undefined, createCliRuntime({ authResolver }));

    await authStatus({ format: 'json' }, ctx);

    const printed = fake.calls.find((c) => c.method === 'print');
    expect(printed).toBeDefined();
    expect(JSON.parse(String(printed?.args[0]))).toEqual({
      status: 'connected',
      server: 'https://sonar.example.com',
      source: 'OS Keychain',
    });
    checkTokenStatusSpy.mockRestore();
  });

  it('prints a JSON payload and sets a failing exit code without throwing when nothing is stored', async () => {
    const authResolver = new AuthResolver();
    spyOn(authResolver, 'resolveAuth').mockReturnValue(okAsync(null));
    const loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(
      getDefaultState('1.0.0'),
    );

    const fake = new FakeConsole();
    const ctx = new CommandInvocationContext(fake, undefined, createCliRuntime({ authResolver }));

    const originalExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      // JSON mode must not throw: the shared command framework would otherwise print
      // its own `❌`/`💡` error text alongside the JSON
      await authStatus({ format: 'json' }, ctx);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
    }
    const printed = fake.calls.find((c) => c.method === 'print');
    expect(printed).toBeDefined();
    expect(JSON.parse(String(printed?.args[0]))).toEqual({ status: 'not_authenticated' });
    loadStateSpy.mockRestore();
  });
});
