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

// SessionStart/SubagentStart handler — injects Vortex context at agent startup.
// CAG is the sole subscriber of these events (unlike PostToolUse, shared with
// SQAA), so this is a direct, fail-open forwarder rather than a dispatcher —
// see claude-post-tool-use-failure.ts for the same shape.

import { existsSync } from 'node:fs';

import { resolveAuth } from '@/core/auth/auth-resolver.ts';
import { resolveContextAugmentationBinaryPath } from '@/core/host/install/context-augmentation.ts';
import logger from '@/core/observability/logger.ts';
import { discoverProject } from '@/core/project-info.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import { resolveVortexEntitlement } from '@/core/vortex/entitlement.ts';

import { resolveContextAugmentationSessionStartText } from '../integrate/_common/context-augmentation.ts';
import type { HookCommandResult } from './hook-command-result.ts';
import { readStdinJsonWithRaw } from './stdin.ts';

interface SessionStartPayload {
  session_id?: string;
  cwd?: string;
  source?: string;
}

/** Max time to wait for CAG's session-start context before failing open. */
const SESSION_START_CONTEXT_TIMEOUT_MS = 5000;

/** Races `promise` against `timeoutMs`, resolving to `null` on timeout rather than rejecting. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, timeoutMs);
    }),
  ]);
}

export async function handleAgentSessionStart(
  hookEventName: 'SessionStart' | 'SubagentStart',
): Promise<HookCommandResult> {
  let payload: SessionStartPayload;
  try {
    ({ parsed: payload } = await readStdinJsonWithRaw<SessionStartPayload>());
  } catch {
    return { agentSessionId: null }; // unparseable stdin — non-blocking
  }
  const agentSessionId = payload.session_id ?? null;

  try {
    const dir = payload.cwd && existsSync(payload.cwd) ? payload.cwd : process.cwd();

    const auth = await resolveAuth().catch(() => null);
    if (!auth) return { agentSessionId };

    // Same shared project-discovery pipeline as resolveSqaaProjectKey (CLI-970): known
    // project mappings, local config files (sonar-project.properties/.sonarlint), then a
    // git-remote-binding lookup — not limited to directories with a prior `sonar integrate`.
    const discovered = await discoverProject(dir, { auth, silent: true });
    if (!discovered.projectKey) return { agentSessionId };

    const { status } = await resolveVortexEntitlement(auth);
    if (status !== 'enabled') return { agentSessionId }; // over_consumption/not_entitled/etc. inject nothing

    const binaryPath = resolveContextAugmentationBinaryPath();
    if (!binaryPath) return { agentSessionId };

    noteProject(auth, discovered.projectKey);

    const contextText = await withTimeout(
      resolveContextAugmentationSessionStartText({
        binaryPath,
        organization: discovered.organization ?? auth.orgKey,
        projectKey: discovered.projectKey,
        serverUrl: discovered.serverUrl ?? auth.serverUrl,
        token: auth.token,
        workspaceDir: discovered.projectRoot,
      }),
      SESSION_START_CONTEXT_TIMEOUT_MS,
    );
    if (!contextText) return { agentSessionId };

    process.stdout.write(
      `${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: contextText } })}\n`,
    );
  } catch (err) {
    logger.debug(`Vortex session-start hook failed: ${(err as Error).message}`);
  }

  return { agentSessionId };
}
