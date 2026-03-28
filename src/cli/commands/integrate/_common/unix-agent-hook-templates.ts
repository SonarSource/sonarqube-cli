/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Shared Unix/bash hook script templates (Claude Code, OpenAI Codex, …)

/**
 * Bash line that prints PreToolUse deny JSON for Claude Code / Codex hooks.
 * Uses shell variable `reason` (set by the caller before this line).
 */
export function bashPreToolUseDenyJsonEchoLine(): string {
  return (
    '  ' +
    String.raw`echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"$reason\"}}"`
  );
}

/** PATH + SONAR for agent hooks (Codex/GUI often lack ~/.local/share/... on PATH). */
export function bashSonarResolveBlock(): string {
  const pathPrefix = String.raw`export PATH="$HOME/.local/share/sonarqube-cli/bin:$HOME/.sonar/sonarqube-cli/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
`;
  return `${pathPrefix}SONAR=$(command -v sonar 2>/dev/null)
if [[ -z "$SONAR" ]]; then
  exit 0
fi`;
}

/** Unix template for sonar-secrets PreToolUse hook (bash) */
export function getSecretPreToolTemplateUnix(): string {
  const sonarBlock = bashSonarResolveBlock();
  return `#!/bin/bash
# PreToolUse hook: Scan files before reading to prevent secret leakage
# Blocks file reads if secrets are detected

${sonarBlock}

# Read JSON from stdin and extract fields using sed (handles both compact and pretty-printed JSON)
stdin_data=$(cat)
tool_name=$(echo "$stdin_data" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)

if [[ "$tool_name" != "Read" ]]; then
  exit 0
fi

file_path=$(echo "$stdin_data" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)

if [[ -z "$file_path" ]] || [[ ! -f "$file_path" ]]; then
  exit 0
fi

"$SONAR" analyze secrets "$file_path" > /dev/null 2>&1
exit_code=$?

if [[ $exit_code -eq 51 ]]; then
  reason="Sonar detected secrets in file: $file_path"
${bashPreToolUseDenyJsonEchoLine()}
  exit 0
fi

exit 0
`;
}

/** Unix template for sonar-secrets UserPromptSubmit hook (bash) */
export function getSecretPromptTemplateUnix(): string {
  const sonarBlock = bashSonarResolveBlock();
  return (
    `#!/bin/bash
# UserPromptSubmit hook: Scan prompt for secrets before sending

${sonarBlock}

stdin_data=$(cat)
# Claude Code: top-level .prompt — OpenAI Codex: .payload.prompt (see Codex hooks docs)
if command -v jq &> /dev/null; then
  prompt=$(printf '%s' "$stdin_data" | jq -r '.prompt // .payload.prompt // empty' 2>/dev/null || true)
else
  prompt=$(echo "$stdin_data" | sed -n 's/.*"prompt"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)
fi

if [[ -z "$prompt" ]]; then
  exit 0
fi

temp_file=$(mktemp -t 'sonarqube-cli-hook.XXXXXX')
trap "rm -f $temp_file" EXIT

printf '%s' "$prompt" > "$temp_file"

"$SONAR" analyze secrets "$temp_file" > /dev/null 2>&1
exit_code=$?

if [[ $exit_code -eq 51 ]]; then
  reason="Sonar detected secrets in prompt"
  ` +
    String.raw`echo "{\"decision\":\"block\",\"reason\":\"$reason\"}"` +
    `
  exit 0
fi

exit 0
`
  );
}

/**
 * Unix template for SQAA PostToolUse hook (bash)
 * Runs after Edit/Write — analyzes the modified file with SQAA.
 */
export function getSqaaPostToolTemplateUnix(projectKey: string): string {
  const sonarBlock = bashSonarResolveBlock();
  return `#!/bin/bash
# PostToolUse hook: Run SQAA analysis on edited/written files

${sonarBlock}

stdin_data=$(cat)
tool_name=$(echo "$stdin_data" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)

if [[ "$tool_name" != "Edit" ]] && [[ "$tool_name" != "Write" ]]; then
  exit 0
fi

file_path=$(echo "$stdin_data" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)

if [[ -z "$file_path" ]] || [[ ! -f "$file_path" ]]; then
  exit 0
fi

output=$("$SONAR" analyze sqaa --file "$file_path" --project ${projectKey} 2>/dev/null)

escaped=$(printf '%s' "$output" | awk 'BEGIN{ORS=""} {gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r"); if(NR>1) printf "\\n"; print}')

printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' "$escaped"

exit 0
`;
}
