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

import { describe, expect, it } from 'bun:test';

import { offerIntegrate } from '@/commands/init/steps/integrate.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

const AUTH = new ResolvedAuth({
  token: 't',
  serverUrl: 'https://sonarcloud.io',
  orgKey: 'org',
  connectionType: 'cloud',
  source: 'state',
});

function setup(answer?: boolean | null) {
  const console = new FakeConsole();
  if (answer !== undefined) {
    console.queueResponse(answer);
  }
  return { console, ctx: new CommandInvocationContext(console) };
}

describe('offerIntegrate', () => {
  it('asks with a default of yes and runs integrate with the established auth', async () => {
    const { console, ctx } = setup();
    let received: unknown;

    await offerIntegrate(ctx, AUTH, (integrateCtx) => {
      received = integrateCtx.auth;
      return Promise.resolve();
    });

    expect(console.findCall('confirmPrompt', 'sonar integrate')?.args[1]).toBe(true);
    expect(received).toBe(AUTH);
  });

  it('does not run integrate and prints nothing more when declined', async () => {
    const { console, ctx } = setup(false);
    let ran = false;

    await offerIntegrate(ctx, AUTH, () => {
      ran = true;
      return Promise.resolve();
    });

    expect(ran).toBe(false);
    expect(console.findCall('print', 'sonar integrate')).toBeUndefined();
  });

  it('cancels onboarding on Ctrl+C', async () => {
    const { ctx } = setup(null);

    const error = await offerIntegrate(ctx, AUTH, () => Promise.resolve()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as Error).message).toBe('Onboarding cancelled.');
  });

  it('warns with the manual hint when integrate fails, without throwing', async () => {
    const { console, ctx } = setup(true);

    await offerIntegrate(ctx, AUTH, () =>
      Promise.reject(new CommandFailedError('No integration selected')),
    );

    const warning = console.findCall('warn', 'No integration selected');
    expect(String(warning?.args[0])).toContain("Run 'sonar integrate' to try again.");
  });
});
