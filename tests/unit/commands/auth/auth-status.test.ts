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
import { okAsync } from '@/core/result.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

describe('authStatus with FakeConsole', () => {
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
