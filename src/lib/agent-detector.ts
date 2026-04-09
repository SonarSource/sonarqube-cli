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

export type CallerAgent = 'cursor' | 'claude';

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

/**
 * Claude Code markers take precedence when both families could be set.
 *
 * @param env - Defaults to `process.env`; inject a custom object for tests.
 */
export function detectCallerAgent(env: NodeJS.ProcessEnv = process.env): CallerAgent | null {
  if (isClaudeCodeAgentEnv(env)) return 'claude';
  if (isCursorAgentEnv(env)) return 'cursor';
  return null;
}
