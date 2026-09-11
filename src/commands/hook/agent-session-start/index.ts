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

// SessionStart/SubagentStart handler — fetches the condensed Vortex skill from
// sonar-context-augmentation and injects it as additional context at session start.
// Fails open at every step: a hook that blocks or errors on agent startup is
// worse than one that delivers no context.

import {
  ENV_SKIP_CAG,
  isContextAugmentationSkipped,
  printSessionStartContext,
} from '@/commands/integrate/_common/context-augmentation.ts';
import { type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolveContextAugmentationBinaryPath } from '@/core/host/install/context-augmentation.ts';
import logger from '@/core/observability/logger.ts';
import { discoverProject } from '@/core/project-info.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { ScaClient } from '@/core/server/sca.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import { resolveVortexEntitlement } from '@/core/vortex/entitlement.ts';

import type { HookCommandResult } from '../hook-command-result.ts';
import { readStdinJson } from '../stdin.ts';
import { claudeCodexAdapter } from './agent-adapters/claude-codex-adapter.ts';
import { copilotAdapter } from './agent-adapters/copilot-adapter.ts';
import { cursorAdapter } from './agent-adapters/cursor-adapter.ts';
import type {
  SessionStartAgent,
  SessionStartAgentAdapter,
  SessionStartInput,
  SessionStartOutput,
} from './types.ts';

export async function agentSessionStart(
  ctx: CommandInvocationContext,
  agent: string,
): Promise<HookCommandResult> {
  let sessionId: string | undefined;
  try {
    const adapter = resolveAdapter(agent);
    if (!adapter) {
      logSkip(`unknown agent '${agent}'`);
      return { agentSessionId: null };
    }

    let input: SessionStartInput;
    try {
      input = adapter.parse(await readStdinJson<unknown>());
    } catch {
      logSkip('unparseable stdin');
      return { agentSessionId: null };
    }
    sessionId = input.sessionId;

    const output = await resolveSessionStartContext(ctx, input);
    if (output !== null) {
      process.stdout.write(JSON.stringify(adapter.emit(output, input)) + '\n');
    }
  } catch (err) {
    logSkip((err as Error).message);
  }
  return { agentSessionId: sessionId ?? null };
}

async function resolveSessionStartContext(
  ctx: CommandInvocationContext,
  input: SessionStartInput,
): Promise<SessionStartOutput | null> {
  if (isContextAugmentationSkipped()) {
    logSkip(`${ENV_SKIP_CAG} is set`);
    return null;
  }

  const authResult = await ctx.resolveAuth();
  if (authResult.isErr()) {
    logSkip(authResult.error.message);
    return null;
  }
  const auth = authResult.value;
  if (!auth) {
    logSkip('not authenticated');
    return null;
  }

  const discovered = await discoverProject(input.startDir ?? process.cwd(), {
    auth,
    silent: true,
    console: ctx.console,
  });
  if (!discovered.projectKey) {
    logSkip('no project key resolved');
    return null;
  }
  noteProject(auth, discovered.projectKey);

  const [vortexEntitlement, scaEnabled] = await Promise.all([
    resolveVortexEntitlement(auth),
    isScaEnabled(auth),
  ]);
  if (vortexEntitlement.status !== 'enabled') {
    logSkip(`Vortex entitlement is '${vortexEntitlement.status}'`);
    return null;
  }

  const binaryPath = resolveContextAugmentationBinaryPath();
  if (!binaryPath) {
    logSkip('sonar-context-augmentation is not installed');
    return null;
  }

  const result = await printSessionStartContext({
    binaryPath,
    scaEnabled,
    context: {
      workspaceDir: discovered.projectRoot,
      projectKey: discovered.projectKey,
      serverUrl: auth.serverUrl,
      token: auth.token,
      organization: auth.orgKey,
    },
  });
  if (!result.ok) {
    logSkip(result.failureMessage ?? 'sonar-context-augmentation failed');
    return null;
  }
  if (result.stdout.trim().length === 0) {
    logSkip('sonar-context-augmentation produced no context');
    return null;
  }

  return { additionalContext: result.stdout };
}

function isScaEnabled(auth: ResolvedAuth): Promise<boolean> {
  const client = new ScaClient(new SonarHttpClient(auth.serverUrl, auth.token));
  return client.checkScaEnabled(auth.connectionType, auth.orgKey).orThrow();
}

function logSkip(reason: string): void {
  logger.debug(`Session start context skipped: ${reason}`);
}

const ADAPTERS: Record<SessionStartAgent, SessionStartAgentAdapter> = {
  claude: claudeCodexAdapter,
  codex: claudeCodexAdapter,
  copilot: copilotAdapter,
  cursor: cursorAdapter,
};

function resolveAdapter(agent: string): SessionStartAgentAdapter | undefined {
  return ADAPTERS[agent as SessionStartAgent];
}
