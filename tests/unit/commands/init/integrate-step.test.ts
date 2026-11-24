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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { IntegrateStep } from '@/commands/init/steps/integrate.ts';
import * as installedIntegrations from '@/commands/integrate/_common/installed-integrations.ts';
import * as integrateBareModule from '@/commands/integrate/integrate-bare.ts';
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

describe('IntegrateStep', () => {
  const integrateBare = () => spyOn(integrateBareModule, 'integrateBare');
  const installed = () => spyOn(installedIntegrations, 'findInstalledIntegrationIds');

  beforeEach(() => {
    installed().mockReturnValue([]);
  });

  afterEach(() => {
    integrateBare().mockRestore();
    installed().mockRestore();
  });

  it('offers nothing without a session or a terminal', async () => {
    const { console, ctx } = setup();

    expect((await new IntegrateStep(ctx, undefined, true).run()).outcome).toBe('skipped');
    expect((await new IntegrateStep(ctx, AUTH, false).run()).outcome).toBe('skipped');
    expect(console.findCall('confirmPrompt', 'sonar integrate')).toBeUndefined();
  });

  it('offers nothing when an integration is already installed', async () => {
    const { console, ctx } = setup();
    installed().mockReturnValue(['claude-code']);

    expect((await new IntegrateStep(ctx, AUTH, true).run()).outcome).toBe('already_done');
    expect(console.findCall('confirmPrompt', 'sonar integrate')).toBeUndefined();
  });

  it('asks with a default of yes and runs integrate with the established auth', async () => {
    const { console, ctx } = setup();
    const run = integrateBare().mockResolvedValue(undefined);

    await new IntegrateStep(ctx, AUTH, true).run();

    expect(console.findCall('confirmPrompt', 'sonar integrate')?.args[1]).toBe(true);
    expect(run.mock.calls[0]?.[0].auth).toBe(AUTH);
  });

  it('does not run integrate and prints nothing more when declined', async () => {
    const { console, ctx } = setup(false);
    const run = integrateBare().mockResolvedValue(undefined);

    await new IntegrateStep(ctx, AUTH, true).run();

    expect(run).not.toHaveBeenCalled();
    expect(console.findCall('print', 'sonar integrate')).toBeUndefined();
  });

  it('cancels onboarding on Ctrl+C', async () => {
    const { ctx } = setup(null);

    const error = await new IntegrateStep(ctx, AUTH, true).run().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as Error).message).toBe('Onboarding cancelled.');
  });

  it('warns with the manual hint when integrate fails, without throwing', async () => {
    const { console, ctx } = setup(true);

    integrateBare().mockRejectedValue(new CommandFailedError('No integration selected'));

    await new IntegrateStep(ctx, AUTH, true).run();

    const warning = console.findCall('warn', 'No integration selected');
    expect(String(warning?.args[0])).toContain("Run 'sonar integrate' to try again.");
  });
});
