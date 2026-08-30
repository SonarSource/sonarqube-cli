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

// Telemetry constants for the sonar-secrets analyzer's CliAnalysisCompleted event.
// Each analyzer owns the shape of its own `details` blob
// ({ counts_by_rule, files_with_findings_count, source }).
// Bare `sonar analyze` uses caller_command `analyze` (same as SQAA); the dedicated
// `analyze secrets` subcommand uses `analyze secrets`.

/**
 * The `caller_command` value recorded on every sonar-secrets analysis event, one per
 * call site. `agentPromptSubmit` is shared by the Claude and Codex prompt-submit hooks
 * (they are distinguished by `caller_agent`, not `caller_command`).
 */
export const SECRETS_CALLER_COMMANDS = {
  analyze: 'analyze',
  analyzeSecrets: 'analyze secrets',
  analyzeDependencyRisks: 'analyze dependency-risks',
  gitPreCommit: 'git-pre-commit',
  gitPrePush: 'git-pre-push',
  agentPromptSubmit: 'agent-prompt-submit',
  cursorPromptSubmit: 'cursor-prompt-submit',
  claudePreToolUse: 'claude-pre-tool-use',
  copilotPreToolUse: 'copilot-pre-tool-use',
  antigravityPreToolUse: 'antigravity-pre-tool-use',
  cursorPreFileRead: 'cursor-pre-file-read',
  cursorPreToolUse: 'cursor-pre-tool-use',
} as const;

/** Union of the valid sonar-secrets `caller_command` values. */
export type SecretsCallerCommand =
  (typeof SECRETS_CALLER_COMMANDS)[keyof typeof SECRETS_CALLER_COMMANDS];
