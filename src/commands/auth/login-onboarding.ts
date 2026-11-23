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
import { pendingAgentSetups, setupMatches } from '../integrate/_common/pending-agent-setup.ts';
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
    if (needsUnattendedGuidance(opts, ctx)) {
      await reportSetupNextStep(target, json, ctx);
    } else {
      await continueInteractiveSetup(target, ctx);
    }
  } catch {
    if (json) ctx.console.print(JSON.stringify({ status: 'connected', ...target }));
    else ctx.console.warn("Sign-in succeeded. Continue agent setup with 'sonar integrate'.");
  }
}

function needsUnattendedGuidance(opts: AuthLoginOptions, ctx: CommandInvocationContext): boolean {
  return (
    opts.format === 'json' || !!opts.withToken || !ctx.console.canPrompt() || !!detectCallerAgent()
  );
}

async function reportSetupNextStep(
  target: LoginTarget,
  json: boolean,
  ctx: CommandInvocationContext,
) {
  const nextCommand = await findSetupCommand(target, loadState());
  if (json) {
    ctx.console.print(
      JSON.stringify({ status: 'connected', ...target, ...(nextCommand ? { nextCommand } : {}) }),
    );
  } else if (nextCommand) {
    ctx.console.warn('Finish agent setup with ' + nextCommand + '.');
  }
}

async function continueInteractiveSetup(target: LoginTarget, ctx: CommandInvocationContext) {
  const state = loadState();
  if (pendingAgentSetups(state).some((pending) => matchesLogin(target, pending))) {
    const auth = await resolveCompletedLogin(target);
    if (auth && (await resumePendingAgentSetups(ctx, auth))) return;
  }
  await offerPostLoginSetup(ctx, target, state);
}

function matchesLogin(target: LoginTarget, pending: { server?: string; org?: string }): boolean {
  return setupMatches({ serverUrl: target.server, orgKey: target.org }, pending);
}

async function unconfiguredAgents(state: CliState) {
  const pending = new Set(pendingAgentSetups(state).map(({ agent }) => agent));
  const detected = detectInstalledAgents().filter((agent) => !pending.has(agent));
  const readiness = await Promise.all(detected.map((agent) => agentSetupStatus(agent, state)));
  return detected.filter((_agent, index) => readiness[index] === 'Ready to configure');
}

async function findSetupCommand(target: LoginTarget, state: CliState) {
  if (pendingAgentSetups(state).some((pending) => matchesLogin(target, pending)))
    return RESUME_SETUP;
  const agent = (await unconfiguredAgents(state)).at(0);
  return agent ? 'sonar integrate ' + agent + ' --non-interactive' : undefined;
}

async function lookupSetupOffer(target: LoginTarget, state: CliState, signal: AbortSignal) {
  const agents = await unconfiguredAgents(state);
  if (!agents.length || signal.aborted) return;
  const auth = await resolveCompletedLogin(target);
  if (!auth) return;
  const httpClient = new SonarHttpClient(auth.serverUrl, auth.token, signal);
  const entitlement = await resolveVortexEntitlement({ auth, httpClient });
  return { auth, agents, status: entitlement.status };
}

async function offerPostLoginSetup(
  ctx: CommandInvocationContext,
  target: LoginTarget,
  state: CliState,
): Promise<void> {
  const signal = AbortSignal.timeout(POST_LOGIN_BUDGET_MS);
  const fallback = new Promise<null>((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve(null);
      },
      { once: true },
    );
  });
  const offer = await Promise.race([lookupSetupOffer(target, state, signal), fallback]);
  if (offer === null || offer?.status === 'check_failed') {
    ctx.console.info("Continue agent setup with 'sonar integrate'.");
    return;
  }
  if (!offer || (offer.status !== 'enabled' && offer.status !== 'over_consumption')) return;
  const { auth, agents } = offer;

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
