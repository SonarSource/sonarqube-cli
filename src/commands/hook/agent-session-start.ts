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

/**
 * Max time to wait for CAG's session-start context before failing open. Enforced by killing
 * the CAG subprocess itself (see `resolveContextAugmentationSessionStartText`'s `timeoutMs`),
 * not by racing a promise the caller then abandons — an abandoned-but-still-running child
 * process (or a live network request) keeps holding stdio/socket handles open, and this CLI
 * has no explicit `process.exit()`, so the hook process would stay alive exactly as long as
 * anything it started keeps the event loop busy, regardless of what this function returns.
 */
const SESSION_START_CONTEXT_TIMEOUT_MS = 5000;

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
    // project mappings, then local config files (sonar-project.properties/.sonarlint) — not
    // limited to directories with a prior `sonar integrate`. tryGitRemoteBinding is disabled:
    // it's the one source that reaches the server, and unlike the CAG subprocess below its
    // underlying HTTP call can't be killed from here, only bounded by the shared client's own
    // (much longer) request timeout — not acceptable in a hot startup path fired on every
    // session start and every subagent spawn. A repo relying solely on git-remote binding
    // (no local config, no known mapping) simply gets no session-start context; `sonar
    // analyze`/`sonar context` still resolve it normally since they call discoverProject
    // without this override.
    const discovered = await discoverProject(dir, {
      auth,
      silent: true,
      tryGitRemoteBinding: false,
    });
    if (!discovered.projectKey) return { agentSessionId };

    // Bounded by the shared HTTP client's own (30s) request timeout — a pre-existing,
    // non-cancellable ceiling this hook doesn't change. In the ordinary case this resolves
    // in well under a second; Claude's own 60s hook timeout is the outer backstop if the
    // network is genuinely slow.
    const { status } = await resolveVortexEntitlement(auth);
    if (status !== 'enabled') return { agentSessionId }; // over_consumption/not_entitled/etc. inject nothing

    const binaryPath = resolveContextAugmentationBinaryPath();
    if (!binaryPath) return { agentSessionId };

    noteProject(auth, discovered.projectKey);

    const contextText = await resolveContextAugmentationSessionStartText({
      binaryPath,
      organization: discovered.organization ?? auth.orgKey,
      projectKey: discovered.projectKey,
      serverUrl: discovered.serverUrl ?? auth.serverUrl,
      token: auth.token,
      workspaceDir: discovered.projectRoot,
      timeoutMs: SESSION_START_CONTEXT_TIMEOUT_MS,
    });
    if (!contextText) return { agentSessionId };

    process.stdout.write(
      `${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: contextText } })}\n`,
    );
  } catch (err) {
    logger.debug(`Vortex session-start hook failed: ${(err as Error).message}`);
  }

  return { agentSessionId };
}
