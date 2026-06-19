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

/**
 * Infer which AI coding agent that likely invoked the CLI (the "caller"), using environment markers.
 * Best-effort: hook subprocesses often omit variables present in the agent's integrated terminal.
 */

export type CallerAgent = 'cursor' | 'claude' | 'copilot' | 'codex' | 'antigravity';

/** Cursor IDE / agent terminal markers. */
export function isCursorAgentEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.CURSOR_AGENT === '1' || Boolean(env.CURSOR_PROJECT_DIR) || Boolean(env.CURSOR_TRACE_ID)
  );
}

/**
 * Google Antigravity markers. Antigravity also sets Claude-compat vars when the
 * Claude extension is present — prefer this check before `isClaudeCodeAgentEnv`.
 */
export function isAntigravityAgentEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ANTIGRAVITY_AGENT === '1' || env.ANTIGRAVITY_AGENT === 'true';
}

/** Claude Code integrated terminal / tooling markers. */
export function isClaudeCodeAgentEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.CLAUDECODE === '1' || Boolean(env.CLAUDE_CODE_ENTRYPOINT) || Boolean(env.CLAUDE_PROJECT_DIR)
  );
}

/** GitHub Copilot CLI / agent terminal markers. */
export function isCopilotCliAgentEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COPILOT_CLI === '1' || Boolean(env.COPILOT_PROJECT_DIR);
}

/**
 * Codex CLI markers. Presence of any `CODEX_*` variable is sufficient regardless of value —
 * Codex sets these in the hook subprocess environment.
 */
export function isCodexAgentEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return 'CODEX_CI' in env || 'CODEX_SANDBOX_NETWORK_DISABLED' in env || 'CODEX_THREAD_ID' in env;
}

/**
 * Precedence: Codex > Copilot CLI > Antigravity > Claude Code > Cursor.
 * Antigravity sets Claude-compat env vars, so it must be checked before Claude.
 *
 * @param env - Defaults to `process.env`; inject a custom object for tests.
 */
export function detectCallerAgent(env: NodeJS.ProcessEnv = process.env): CallerAgent | null {
  if (isCodexAgentEnv(env)) return 'codex';
  if (isCopilotCliAgentEnv(env)) return 'copilot';
  if (isAntigravityAgentEnv(env)) return 'antigravity';
  if (isClaudeCodeAgentEnv(env)) return 'claude';
  if (isCursorAgentEnv(env)) return 'cursor';
  return null;
}
