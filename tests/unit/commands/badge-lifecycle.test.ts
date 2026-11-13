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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import * as badgeModule from '@/commands/badge/index.ts';
import { createCommandTree } from '@/commands/command-tree.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { QuietConsole } from '@/core/ui/quiet-console.ts';
import * as postUpdate from '@/core/update/post-update.ts';

import { FakeConsole } from '../../_common/fake-console.ts';
import { restoreEnv } from '../../_common/isolated-cli-env.ts';
import { mockAuthResolver } from '../../_common/mock-auth-resolver.ts';

class StatefulConsole extends FakeConsole {
  private formatted = false;
  override setFormattedOutputMode(active: boolean): void {
    this.formatted = active;
  }
  override isFormattedOutputMode(): boolean {
    return this.formatted;
  }
}

describe('badge output lifecycle', () => {
  const auth = new ResolvedAuth({
    token: 'login-token',
    serverUrl: 'https://sonar.example.com',
    connectionType: 'on-premise',
    source: 'state',
  });
  let savedEnv: Record<string, string | undefined>;
  let dir: string;
  let console: StatefulConsole;
  let authMock: ReturnType<typeof mockAuthResolver>;
  let migration: ReturnType<typeof spyOn<typeof postUpdate, 'runPostUpdateActionsSafely'>>;
  let handler: ReturnType<typeof spyOn<typeof badgeModule, 'badge'>>;

  beforeEach(() => {
    savedEnv = { ...process.env };
    dir = mkdtempSync(join(tmpdir(), 'badge-lifecycle-'));
    process.env.SONAR_USER_HOME = dir;
    process.env.DO_NOT_TRACK = '1';
    console = new StatefulConsole();
    authMock = mockAuthResolver(auth);
    migration = spyOn(postUpdate, 'runPostUpdateActionsSafely').mockResolvedValue();
    handler = spyOn(badgeModule, 'badge').mockImplementation((_options, ctx) => {
      expect(ctx.console).toBe(console);
      expect(console.isFormattedOutputMode()).toBe(true);
      console.print('badge-payload');
      return Promise.resolve();
    });
  });

  afterEach(() => {
    migration.mockRestore();
    handler.mockRestore();
    authMock.resolveAuthSpy.mockRestore();
    restoreEnv('SONAR_USER_HOME', savedEnv.SONAR_USER_HOME);
    restoreEnv('DO_NOT_TRACK', savedEnv.DO_NOT_TRACK);
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it.each([false, true])(
    'scopes startup output and restores previous formatted mode %s',
    async (previous) => {
      console.setFormattedOutputMode(previous);
      const spinner = spyOn(console, 'withSpinner');
      migration.mockImplementation(async (deps) => {
        expect(console.isFormattedOutputMode()).toBe(true);
        expect(deps.console).toBeInstanceOf(QuietConsole);
        expect(deps.runtime).toBe(authMock.runtime);
        deps.console.print('migration raw output');
        deps.console.info('migration information');
        await deps.console.withSpinner('Migration', () => Promise.resolve(), 'stdout');
      });
      const tree = createCommandTree({ console, runtime: authMock.runtime });
      await tree.parseAsync(['badge'], { from: 'user' });
      expect(
        console.calls.filter((call) => call.method === 'print').map((call) => call.args[0]),
      ).toEqual(['badge-payload']);
      expect(spinner).toHaveBeenCalledWith('Migration', expect.any(Function), 'stderr');
      expect(console.isFormattedOutputMode()).toBe(previous);
    },
  );

  it('restores formatted mode after a handled command failure', async () => {
    handler.mockRejectedValue(new CommandFailedError('Badge failed'));
    const tree = createCommandTree({ console, runtime: authMock.runtime });
    await tree.parseAsync(['badge'], { from: 'user' });
    expect(console.isFormattedOutputMode()).toBe(false);
    expect(console.findCall('error', 'Badge failed')).toBeDefined();
    expect(process.exitCode).toBe(1);
  });

  it('keeps other commands on their existing console and output mode', async () => {
    migration.mockImplementation((deps) => {
      expect(deps.console).toBe(console);
      expect(console.isFormattedOutputMode()).toBe(false);
      return Promise.resolve();
    });
    const tree = createCommandTree({ console, runtime: authMock.runtime });
    tree.command('probe').anonymousAction((ctx) => {
      ctx.console.print('probe');
    });
    await tree.parseAsync(['probe'], { from: 'user' });
    expect(console.findCall('print', 'probe')).toBeDefined();
    expect(console.isFormattedOutputMode()).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
