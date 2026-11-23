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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import type {
  CommandAuthenticatedInvocationContext,
  CommandInvocationContext,
} from '@/core/commands/invocation-context.ts';
import {
  agentDisplayName,
  type DetectedAgentId,
  detectInstalledAgents,
} from '@/core/host/environment/installed-agent-detector.ts';
import { loadState } from '@/core/state/state-repository.ts';
import type { Console } from '@/core/ui/console.ts';

import { authLogin } from '../auth/login.ts';
import { resolveCompletedLogin } from '../auth/login-onboarding.ts';
import {
  integrateAllAgents,
  previewBulkSetup,
  resumePendingAgentSetups,
} from './_common/bulk-agent-setup.ts';
import { findInstalledIntegrationIds } from './_common/installed-integrations.ts';
import {
  pendingAgentSetups,
  resolveSetupTarget,
  type SetupTarget,
} from './_common/pending-agent-setup.ts';
import { integrateAntigravity } from './antigravity';
import { antigravityIntegration } from './antigravity/declaration.ts';
import { integrateClaude } from './claude';
import { claudeIntegration } from './claude/declaration.ts';
import { integrateCodex } from './codex';
import { codexIntegration } from './codex/declaration.ts';
import { integrateCopilot } from './copilot';
import { copilotIntegration } from './copilot/declaration.ts';
import { integrateCursor } from './cursor';
import { cursorIntegration } from './cursor/declaration.ts';
import { integrateDevin } from './devin';
import { devinIntegration } from './devin/declaration.ts';
import { integrateGit } from './git';
import {
  HUSKY_INTEGRATION_ID,
  NATIVE_GIT_INTEGRATION_ID,
  PRE_COMMIT_INTEGRATION_ID,
} from './git/tools';
import { integrateOpenCode } from './opencode';
import { openCodeIntegration } from './opencode/declaration.ts';
import { integratePi } from './pi';
import { piIntegration } from './pi/declaration.ts';

export interface IntegrateBareOptions extends SetupTarget {
  nonInteractive?: boolean;
  all?: boolean;
  /** Marks handlers as invoked via the bare router; forwarded to telemetry only. */
  isFromRouter?: boolean;
}

type Handler = (
  options: IntegrateBareOptions,
  ctx: CommandAuthenticatedInvocationContext,
) => Promise<void>;

const TOOLS: { label: string; handler: Handler; agent?: DetectedAgentId }[] = [
  { label: claudeIntegration.displayName, handler: integrateClaude, agent: 'claude' },
  { label: copilotIntegration.displayName, handler: integrateCopilot, agent: 'copilot' },
  { label: codexIntegration.displayName, handler: integrateCodex, agent: 'codex' },
  { label: cursorIntegration.displayName, handler: integrateCursor, agent: 'cursor' },
  {
    label: antigravityIntegration.displayName,
    handler: integrateAntigravity,
    agent: 'antigravity',
  },
  { label: openCodeIntegration.displayName, handler: integrateOpenCode, agent: 'opencode' },
  { label: devinIntegration.displayName, handler: integrateDevin, agent: 'devin' },
  { label: piIntegration.displayName, handler: integratePi, agent: 'pi' },
  // Git has 3 separate tool declarations (native, husky, pre-commit)
  // but a single handler that detects which framework is in use.
  { label: 'Git', handler: integrateGit },
];

/** Maps a recorded `integrationId` (state.json) to the label shown in the tool-selection prompt. */
const INTEGRATION_ID_LABELS: Record<string, string> = {
  [claudeIntegration.id]: claudeIntegration.displayName,
  [copilotIntegration.id]: copilotIntegration.displayName,
  [codexIntegration.id]: codexIntegration.displayName,
  [cursorIntegration.id]: cursorIntegration.displayName,
  [antigravityIntegration.id]: antigravityIntegration.displayName,
  [openCodeIntegration.id]: openCodeIntegration.displayName,
  [devinIntegration.id]: devinIntegration.displayName,
  [piIntegration.id]: piIntegration.displayName,
  [NATIVE_GIT_INTEGRATION_ID]: 'Git',
  [HUSKY_INTEGRATION_ID]: 'Git',
  [PRE_COMMIT_INTEGRATION_ID]: 'Git',
};

/** Agent pairs known to fight over hook execution when both are integrated on the same machine. */
const CONFLICTING_AGENT_PAIRS: readonly (readonly [DetectedAgentId, DetectedAgentId])[] = [
  ['claude', 'cursor'],
  ['claude', 'copilot'],
  ['claude', 'devin'],
];

/** Tools already integrated (any recorded feature), for display alongside detected agents. */
function findAlreadyIntegrated(): string[] {
  const labels = new Set<string>();
  for (const id of findInstalledIntegrationIds()) {
    const label = INTEGRATION_ID_LABELS[id];
    if (label) labels.add(label);
  }
  return [...labels];
}

function joinNaturally(names: string[]): string {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function noteConflictingAgents(detected: DetectedAgentId[], console: Console): void {
  const conflicting = detected.filter((agent) =>
    CONFLICTING_AGENT_PAIRS.some(
      (pair) => pair.includes(agent) && pair.every((member) => detected.includes(member)),
    ),
  );
  if (conflicting.length === 0) return;

  console.info(
    `${joinNaturally(conflicting.map((agent) => agentDisplayName(agent)))} may conflict at the hook level.`,
  );
  console.print("   → Run 'sonar integrate' again anytime to add, customize or remove an agent.");
}

export async function integrateBare(
  ctx: CommandAuthenticatedInvocationContext,
  options: IntegrateBareOptions,
): Promise<void> {
  const { console } = ctx;

  const detected = detectInstalledAgents();
  if (options.nonInteractive) {
    throw new InvalidOptionError(
      '--non-interactive requires an explicit agent.',
      'Run `sonar integrate <agent> --non-interactive`, e.g. `sonar integrate claude --non-interactive`.',
    );
  }

  const selected = await selectIntegration(console, detected);
  if (!selected) throw new CommandFailedError('No integration selected');

  if (selected === 'all') {
    if (await previewBulkSetup(console, detected))
      await integrateAllAgents(ctx, ctx.auth, detected);
    return;
  }

  await selected.handler({ ...options, isFromRouter: true }, ctx);
}

async function selectIntegration(console: Console, detected: DetectedAgentId[]) {
  if (detected.length > 0) {
    console.info(`Detected agents on your machine: ${detected.map(agentDisplayName).join(', ')}`);
  }

  const alreadyIntegrated = findAlreadyIntegrated();
  if (alreadyIntegrated.length > 0) {
    console.info(`Already integrated: ${alreadyIntegrated.join(', ')}`);
  }

  noteConflictingAgents(detected, console);

  return console.selectPrompt<(typeof TOOLS)[number] | 'all'>(
    'Select the tool you want to integrate with',
    [
      ...TOOLS.map((tool) => ({ value: tool, label: tool.label })),
      ...(detected.length ? [{ value: 'all' as const, label: 'Set up all detected agents' }] : []),
    ],
  );
}

async function prepareWithSignInChoice(
  ctx: CommandInvocationContext,
  auth: ResolvedAuth | null,
  agents: DetectedAgentId[],
  target: SetupTarget,
): Promise<void> {
  if (!(await previewBulkSetup(ctx.console, agents))) return;
  await integrateAllAgents(ctx, auth, agents, target);
  const pending = pendingAgentSetups(loadState()).find(
    (setup) => setup.status === 'waiting_for_sign_in' && agents.includes(setup.agent),
  );
  if (!pending) return;

  const choice = await ctx.console.selectPrompt('When would you like to sign in?', [
    { value: 'now', label: 'Sign in now' },
    { value: 'later', label: 'Sign in later' },
  ]);
  if (choice !== 'now') {
    ctx.console.info("Run 'sonar auth login' when you are ready to finish agent setup.");
    return;
  }

  const loginTarget = await authLogin({ server: pending.server, org: pending.org }, ctx);
  const completed = await resolveCompletedLogin(loginTarget);
  if (completed) await resumePendingAgentSetups(ctx, completed);
}

export async function dispatchIntegration(
  ctx: CommandInvocationContext,
  options: IntegrateBareOptions,
): Promise<void> {
  const auth = await ctx.resolveAuth();
  if (auth.isErr()) throw auth.error;

  if (options.all) {
    const target = resolveSetupTarget(options);
    const detected = detectInstalledAgents();
    if (!options.nonInteractive) {
      if (!ctx.console.canPrompt())
        throw new InvalidOptionError('Use --non-interactive for unattended setup.');
      return prepareWithSignInChoice(ctx, auth.value, detected, target);
    }
    return integrateAllAgents(ctx, auth.value, detected, target);
  }
  if (options.server !== undefined || options.org !== undefined) {
    throw new InvalidOptionError('--server and --org require --all.');
  }
  if (!auth.value) {
    if (options.nonInteractive || !ctx.console.canPrompt()) {
      throw new CommandFailedError('Not authenticated.', {
        remediationHint: "Run 'sonar auth login' to authenticate.",
      });
    }
    const detected = detectInstalledAgents();
    const selected = await selectIntegration(ctx.console, detected);
    if (!selected) throw new CommandFailedError('No integration selected');
    if (selected === 'all') return prepareWithSignInChoice(ctx, null, detected, {});
    if (selected.agent) return prepareWithSignInChoice(ctx, null, [selected.agent], {});
    throw new CommandFailedError('Not authenticated.', {
      remediationHint: "Run 'sonar auth login' to authenticate before setting up Git hooks.",
    });
  }
  const child = ctx.withAuth(auth.value);
  try {
    await integrateBare(child, options);
  } finally {
    ctx.recordTelemetry(...child.telemetryFacts());
    for (const fact of child.statsFacts()) ctx.recordStats(() => fact);
  }
}
