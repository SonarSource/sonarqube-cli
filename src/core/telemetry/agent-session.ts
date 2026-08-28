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

// Resolves an opaque agent session id from agent-native sources only.
// Never invents IDs; never reinterprets thread vs session semantics.
//
// buildCommandTree captures a hook-returned id and postAction passes it to
// resolveAgentSessionId, which trims empty values and falls back to env.

import { tryLoadState } from '@/core/state/state-manager.ts';

import { isTelemetryEnabled } from './enabled.ts';

function nonEmptyTrimmed(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function shouldIdentifyAgentSession(): boolean {
  const state = tryLoadState();
  return state != null && isTelemetryEnabled(state);
}

function normalizeAgentSessionId(value: unknown): string | null {
  return typeof value === 'string' ? nonEmptyTrimmed(value) : null;
}

/**
 * Resolve an agent session id from environment variables only (no hook payload).
 *
 * Priority (first non-empty trimmed string):
 * 1. CLAUDE_CODE_SESSION_ID
 * 2. CODEX_SESSION_ID
 * 3. CODEX_THREAD_ID
 * 4. GEMINI_SESSION_ID
 * 5. else null
 */
export function resolveAgentSessionIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return (
    nonEmptyTrimmed(env.CLAUDE_CODE_SESSION_ID) ??
    nonEmptyTrimmed(env.CODEX_SESSION_ID) ??
    nonEmptyTrimmed(env.CODEX_THREAD_ID) ??
    nonEmptyTrimmed(env.GEMINI_SESSION_ID)
  );
}

/**
 * Prefers a hook-payload id (normalized); otherwise falls back to env.
 * Callers that have not already verified telemetry is on should use
 * {@link resolveAgentSessionId} instead.
 */
export function resolveAgentSessionIdFromHookOrEnv(
  hookSessionId: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return normalizeAgentSessionId(hookSessionId) ?? resolveAgentSessionIdFromEnv(env);
}

/**
 * Lazily identify the agent session id for telemetry. Returns null when
 * collection is disabled. Prefers a hook-captured id (normalized); otherwise
 * falls back to env.
 */
export function resolveAgentSessionId(
  hookSessionId: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!shouldIdentifyAgentSession()) return null;
  return resolveAgentSessionIdFromHookOrEnv(hookSessionId, env);
}
