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

import { printSessionStartContext } from '@/commands/integrate/_common/context-augmentation.ts';
import { isSonarQubeCloud, resolveAuth, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { resolveContextAugmentationBinaryPath } from '@/core/host/install/context-augmentation.ts';
import logger from '@/core/observability/logger.ts';
import { discoverProject } from '@/core/project-info.ts';
import { SonarQubeClient } from '@/core/server/client.ts';
import { resolveVortexEntitlement } from '@/core/vortex/entitlement.ts';

import type { HookCommandResult } from '../hook-command-result.ts';
import { readStdinJson } from '../stdin.ts';
import { resolveSessionStartAdapter } from './agent-adapters.ts';
import type { SessionStartInput, SessionStartOutput } from './types.ts';

function logSkip(reason: string): void {
  logger.debug(`Session start context skipped: ${reason}`);
}

export async function agentSessionStart(agent: string): Promise<HookCommandResult> {
  let sessionId: string | undefined;
  try {
    const adapter = resolveSessionStartAdapter(agent);
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

    const output = await resolveSessionStartContext(input);
    if (output !== null) {
      adapter.emit(output, input);
    }
  } catch (err) {
    logSkip((err as Error).message);
  }
  return { agentSessionId: sessionId ?? null };
}

async function resolveSessionStartContext(
  input: SessionStartInput,
): Promise<SessionStartOutput | null> {
  const auth = await resolveAuth().catch(() => null);
  if (!auth) {
    logSkip('not authenticated');
    return null;
  }

  const discovered = await discoverProject(input.startDir ?? process.cwd(), {
    auth,
    silent: true,
  });
  if (!discovered.projectKey) {
    logSkip('no project key resolved');
    return null;
  }

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

async function isScaEnabled(auth: ResolvedAuth): Promise<boolean> {
  try {
    return await new SonarQubeClient(auth.serverUrl, auth.token).checkScaEnabled(
      isSonarQubeCloud(auth.serverUrl) ? 'cloud' : 'on-premise',
      auth.orgKey,
    );
  } catch (err) {
    logger.debug(`Session start context: SCA availability check failed: ${(err as Error).message}`);
    return false;
  }
}
