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

import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import {
  agentDisplayName,
  type DetectedAgentId,
  detectInstalledAgents,
} from '@/core/host/environment/installed-agent-detector.ts';
import { tryLoadState } from '@/core/state/state-repository.ts';
import type { Console } from '@/core/ui/console.ts';

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
import { integrateGit } from './git';
import {
  HUSKY_INTEGRATION_ID,
  NATIVE_GIT_INTEGRATION_ID,
  PRE_COMMIT_INTEGRATION_ID,
} from './git/tools';

export interface IntegrateBareOptions {
  nonInteractive?: boolean;
  /** Marks handlers as invoked via the bare router; forwarded to telemetry only. */
  isFromRouter?: boolean;
}

type Handler = (
  options: IntegrateBareOptions,
  ctx: CommandAuthenticatedInvocationContext,
) => Promise<void>;

const TOOLS: { label: string; handler: Handler }[] = [
  { label: claudeIntegration.displayName, handler: integrateClaude },
  { label: copilotIntegration.displayName, handler: integrateCopilot },
  { label: codexIntegration.displayName, handler: integrateCodex },
  { label: cursorIntegration.displayName, handler: integrateCursor },
  { label: antigravityIntegration.displayName, handler: integrateAntigravity },
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
  [NATIVE_GIT_INTEGRATION_ID]: 'Git',
  [HUSKY_INTEGRATION_ID]: 'Git',
  [PRE_COMMIT_INTEGRATION_ID]: 'Git',
};

/** Agent pairs known to fight over hook execution when both are integrated on the same machine. */
const CONFLICTING_AGENT_PAIRS: readonly (readonly [DetectedAgentId, DetectedAgentId])[] = [
  ['claude', 'cursor'],
  ['claude', 'copilot'],
];

/** Tools already integrated (any recorded feature), for display alongside detected agents. */
function findAlreadyIntegrated(): string[] {
  const state = tryLoadState();
  if (!state) return [];
  const labels = new Set<string>();
  for (const integration of state.integrations.installed) {
    if (integration.features.length === 0) continue;
    const label = INTEGRATION_ID_LABELS[integration.integrationId];
    if (label) labels.add(label);
  }
  return [...labels];
}

function warnAboutConflictingAgents(detected: DetectedAgentId[], console: Console): void {
  for (const [first, second] of CONFLICTING_AGENT_PAIRS) {
    if (detected.includes(first) && detected.includes(second)) {
      console.warn(
        `Both ${agentDisplayName(first)} and ${agentDisplayName(second)} were detected on this machine. Integrating with both may cause conflicts in hook execution.`,
      );
    }
  }
}

export async function integrateBare(
  ctx: CommandAuthenticatedInvocationContext,
  options: IntegrateBareOptions,
): Promise<void> {
  const { console } = ctx;

  if (options.nonInteractive) {
    throw new InvalidOptionError(
      '--non-interactive requires an explicit agent.',
      'Run `sonar integrate <agent> --non-interactive`, e.g. `sonar integrate claude --non-interactive`.',
    );
  }

  const detected = detectInstalledAgents();
  if (detected.length > 0) {
    console.info(`Detected agents on your machine: ${detected.map(agentDisplayName).join(', ')}`);
  }

  const alreadyIntegrated = findAlreadyIntegrated();
  if (alreadyIntegrated.length > 0) {
    console.info(`Already integrated: ${alreadyIntegrated.join(', ')}`);
  }

  warnAboutConflictingAgents(detected, console);

  const selected = await console.selectPrompt(
    'Select the tool you want to integrate with',
    TOOLS.map((tool) => ({ value: tool, label: tool.label })),
  );

  if (!selected) throw new CommandFailedError('No integration selected');

  await selected.handler({ ...options, isFromRouter: true }, ctx);
}
