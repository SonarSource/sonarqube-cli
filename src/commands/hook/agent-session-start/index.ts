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
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolveContextAugmentationBinaryPath } from '@/core/host/install/context-augmentation.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import {
  type CompleteProjectMapping,
  isSameConnection,
} from '@/core/project-discovery/project-discovery-result.ts';
import {
  type DiscoveredProject,
  discoverProject,
  discoverProjects,
} from '@/core/project-discovery/project-info.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import { ScaClient } from '@/core/server/sca.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import { resolveVortexEntitlement } from '@/core/vortex/entitlement.ts';

import type { HookCommandResult } from '../hook-command-result.ts';
import { readStdinJson } from '../stdin.ts';
import {
  claudeCodexAdapter,
  userVisibleClaudeCodexAdapter,
} from './agent-adapters/claude-codex-adapter.ts';
import { copilotAdapter } from './agent-adapters/copilot-adapter.ts';
import { cursorAdapter } from './agent-adapters/cursor-adapter.ts';
import { piAdapter } from './agent-adapters/pi-adapter.ts';
import { buildMultiProjectContext } from './multi-project-context.ts';
import { claimSessionWarning } from './session-warning.ts';
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

    // Suppress failure warnings on SubagentStart by passing reportFailures=false.
    const output = await resolveSessionStartContext(
      ctx,
      input,
      input.eventName !== 'SubagentStart',
    );
    if (output !== null && (!output.userMessage || claimSessionWarning(agent, sessionId))) {
      process.stdout.write(JSON.stringify(adapter.emit(output, input)) + '\n');
    }
  } catch (err) {
    logSkip((err as Error).message);
  }
  return { agentSessionId: sessionId ?? null };
}

export async function resolveSessionStartContext(
  ctx: CommandInvocationContext,
  input: SessionStartInput,
  reportFailures = false,
): Promise<SessionStartOutput | null> {
  try {
    const output = await loadSessionStartContext(ctx, input);
    return output?.userMessage && !reportFailures ? null : output;
  } catch (error) {
    logSkip((error as Error).message);
    if (!reportFailures) {
      return null;
    }
    return contextWarning(
      "An unexpected error occurred. Run 'sonar auth status' and check the CLI debug logs.",
    );
  }
}

async function loadSessionStartContext(
  ctx: CommandInvocationContext,
  input: SessionStartInput,
): Promise<SessionStartOutput | null> {
  if (isContextAugmentationSkipped()) {
    logSkip(`${ENV_SKIP_CAG} is set`);
    return null;
  }

  const connection = await ctx.resolveConnection();
  const startDir = input.startDir ?? process.cwd();
  const discovered = await discoverProject(startDir, {
    auth: connection?.auth ?? null,
    silent: true,
    console: ctx.console,
  });
  const hasSonarConfig = discovered.hasSonarConfig === true;
  if (!connection) {
    return hasSonarConfig
      ? contextWarning(
          "No usable credentials. Run 'sonar auth status', then 'sonar auth login' if needed.",
        )
      : null;
  }
  const { auth } = connection;

  if (!discovered.projectKey && !discovered.ambiguousProject) {
    if (!hasSonarConfig && !discovered.gitRemoteBindingNotFound) {
      logSkip('no project key or Sonar configuration resolved');
      return null;
    }
    return contextWarning(
      "No project was found. Run 'sonar link <projectKey>' from the project directory.",
    );
  }
  const target = await resolveSessionStartTarget(discovered, startDir, auth, ctx);
  if (!target) {
    return null;
  }

  const [vortexEntitlement, scaEnabled] = await Promise.all([
    resolveVortexEntitlement(connection),
    isScaEnabled(connection),
  ]);
  if (vortexEntitlement.status !== 'enabled') {
    logSkip(`Vortex entitlement is '${vortexEntitlement.status}'`);
    return contextWarning(
      "Vortex is unavailable for this connection. Run 'sonar auth status' and 'sonar system status'.",
    );
  }

  const binaryPath = resolveContextAugmentationBinaryPath();
  if (!binaryPath) {
    return contextWarning(
      "The context binary is not installed. Run 'sonar integrate' for your agent.",
    );
  }

  const result = await printSessionStartContext({
    binaryPath,
    scaEnabled,
    context: {
      workspaceDir: target.workspaceDir,
      projectKey: target.projectKey,
      serverUrl: auth.serverUrl,
      token: auth.token,
      organization: auth.orgKey,
    },
  });
  if (!result.ok) {
    logSkip(result.failureMessage ?? 'sonar-context-augmentation failed');
    return contextWarning(
      "The context command failed. Run 'sonar auth status' and 'sonar system status'.",
    );
  }
  if (result.stdout.trim().length === 0) {
    return contextWarning(
      "The context command returned no context. Run 'sonar system status' and check the CLI debug logs.",
    );
  }

  return {
    additionalContext: target.projects
      ? `${result.stdout.trimEnd()}\n\n${buildMultiProjectContext(target.workspaceDir, target.projects)}`
      : result.stdout,
  };
}

/** A multi-project workspace has no `projectKey`: CAG renders the session-start context from the organization alone. */
type SessionStartTarget =
  | { workspaceDir: string; projectKey: string; projects?: undefined }
  | { workspaceDir: string; projectKey?: undefined; projects: CompleteProjectMapping[] };

async function resolveSessionStartTarget(
  discovered: DiscoveredProject,
  startDir: string,
  auth: ResolvedAuth,
  ctx: CommandInvocationContext,
): Promise<SessionStartTarget | null> {
  if (discovered.projectKey) {
    noteProject(auth, discovered.projectKey);
    return { workspaceDir: discovered.projectRoot, projectKey: discovered.projectKey };
  }
  // Only `.sonar-config.json` yields several projects, so listing them needs no server lookup.
  const invocationDir = canonicalizePath(startDir);
  const scoped = (
    await discoverProjects(invocationDir, { auth, silent: true, console: ctx.console })
  ).scope(invocationDir);
  if (!isSameConnection(scoped)) {
    logSkip('projects in this workspace use different connections');
    return null;
  }
  return { workspaceDir: invocationDir, projects: scoped };
}

function contextWarning(reason: string): SessionStartOutput {
  logSkip(reason);
  const userMessage = `Vortex context was not loaded. ${reason}`;
  return { userMessage, additionalContext: `Tell the user: ${userMessage}` };
}

function isScaEnabled({ auth, httpClient }: SonarConnection): Promise<boolean> {
  const client = new ScaClient(httpClient);
  return client.checkScaEnabled(auth.connectionType, auth.orgKey).orThrow();
}

function logSkip(reason: string): void {
  logger.debug(`Session start context skipped: ${reason}`);
}

const ADAPTERS: Record<SessionStartAgent, SessionStartAgentAdapter> = {
  claude: userVisibleClaudeCodexAdapter,
  codex: userVisibleClaudeCodexAdapter,
  copilot: copilotAdapter,
  cursor: cursorAdapter,
  devin: claudeCodexAdapter,
  pi: piAdapter,
};

function resolveAdapter(agent: string): SessionStartAgentAdapter | undefined {
  return ADAPTERS[agent as SessionStartAgent];
}
