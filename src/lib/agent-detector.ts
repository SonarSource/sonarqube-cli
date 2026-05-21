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

export type CallerAgent = 'cursor' | 'claude' | 'copilot' | 'codex';

/** Cursor IDE / agent terminal markers. */
export function isCursorAgentEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.CURSOR_AGENT === '1' || Boolean(env.CURSOR_PROJECT_DIR) || Boolean(env.CURSOR_TRACE_ID)
  );
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
 * Precedence: Codex > Copilot CLI > Claude Code > Cursor.
 * Codex and Copilot CLI vars are the most specific (unlikely to collide);
 * Claude Code beats Cursor when both families could be set.
 *
 * @param env - Defaults to `process.env`; inject a custom object for tests.
 */
export function detectCallerAgent(env: NodeJS.ProcessEnv = process.env): CallerAgent | null {
  if (isCodexAgentEnv(env)) return 'codex';
  if (isCopilotCliAgentEnv(env)) return 'copilot';
  if (isClaudeCodeAgentEnv(env)) return 'claude';
  if (isCursorAgentEnv(env)) return 'cursor';
  return null;
}
