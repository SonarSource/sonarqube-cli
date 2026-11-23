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

import { AuthResolver, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { authMatchesRecordedConnection } from '@/core/auth/recorded-connection.ts';
import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { CommandInvocationContext, TelemetryFact } from '@/core/commands/invocation-context.ts';
import { detectCallerAgent } from '@/core/host/environment/agent-detector.ts';
import { detectInstalledAgents } from '@/core/host/environment/installed-agent-detector.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import type { CliState } from '@/core/state/state.ts';
import { loadState } from '@/core/state/state-repository.ts';
import { QuietConsole } from '@/core/ui/quiet-console.ts';
import { resolveVortexEntitlement } from '@/core/vortex/entitlement.ts';

import {
  agentSetupStatus,
  integrateAllAgents,
  resumePendingAgentSetups,
} from '../integrate/_common/bulk-agent-setup.ts';
import { pendingAgentSetups } from '../integrate/_common/pending-agent-setup.ts';
import { authLogin, type AuthLoginOptions, type LoginTarget } from './login.ts';

const RESUME_SETUP = 'sonar integrate --all --non-interactive';
const POST_LOGIN_BUDGET_MS = 450;

export async function resolveCompletedLogin(target: LoginTarget): Promise<ResolvedAuth | null> {
  const fresh = await new AuthResolver().resolveAuth({ silent: true });
  if (fresh.isErr() || !fresh.value || fresh.value.comesFromEnv()) return null;
  return authMatchesRecordedConnection(fresh.value, {
    serverUrl: target.server,
    organization: target.org,
  })
    ? fresh.value
    : null;
}

export async function loginAndResumeOnboarding(
  opts: AuthLoginOptions,
  ctx: CommandInvocationContext,
): Promise<void> {
  const json = opts.format === 'json';
  if (json && !opts.withToken) {
    throw new InvalidOptionError('--format json requires --with-token.');
  }
  const loginContext = json ? new CommandInvocationContext(new QuietConsole(ctx.console)) : ctx;
  const target = await authLogin(opts, loginContext);
  try {
    const state = loadState();
    const pending = pendingAgentSetups(state);
    if (json) {
      ctx.console.print(
        JSON.stringify({
          status: 'connected',
          ...target,
          ...(pending.length ? { nextCommand: RESUME_SETUP } : {}),
        }),
      );
      return;
    }
    if (opts.withToken || !ctx.console.canPrompt() || detectCallerAgent()) {
      if (pending.length) ctx.console.warn("Finish pending setup with '" + RESUME_SETUP + "'.");
      return;
    }
    if (!pending.length && !detectInstalledAgents().length) return;
    const auth = await resolveCompletedLogin(target);
    if (!auth || (await resumePendingAgentSetups(ctx, auth))) return;
    await offerPostLoginSetup(ctx, auth, state);
  } catch {
    if (json) ctx.console.print(JSON.stringify({ status: 'connected', ...target }));
    else ctx.console.warn("Sign-in succeeded. Continue agent setup with 'sonar integrate'.");
  }
}

async function offerPostLoginSetup(
  ctx: CommandInvocationContext,
  auth: ResolvedAuth,
  state: CliState,
): Promise<void> {
  const signal = AbortSignal.timeout(POST_LOGIN_BUDGET_MS);
  const detected = detectInstalledAgents();
  const readiness = await Promise.all(detected.map((agent) => agentSetupStatus(agent, state)));
  const agents = detected.filter((_agent, index) => readiness[index] === 'Ready to configure');
  if (!agents.length) return;

  const httpClient = new SonarHttpClient(auth.serverUrl, auth.token, signal);
  const entitlement = await resolveVortexEntitlement({ auth, httpClient });
  if (entitlement.status === 'check_failed') {
    ctx.console.info("Continue agent setup with 'sonar integrate'.");
    return;
  }
  if (entitlement.status !== 'enabled' && entitlement.status !== 'over_consumption') return;

  ctx.recordTelemetry(new TelemetryFact('CliPostLoginSetupOffered', { agents }, { auth }));
  if (
    await ctx.console.confirmPrompt('Set up SonarQube for your detected coding agents now?', false)
  ) {
    ctx.recordTelemetry(new TelemetryFact('CliPostLoginSetupAccepted', { agents }, { auth }));
    await integrateAllAgents(ctx, auth, agents, {}, 'post_login');
  } else {
    ctx.console.info("You can set up your coding agents later with 'sonar integrate'.");
  }
}
