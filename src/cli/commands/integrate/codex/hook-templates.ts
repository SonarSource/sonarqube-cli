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

// Codex-only Unix hook templates (OpenAI Codex hooks wire format)

import { bashSonarResolveBlock } from '../_common/unix-agent-hook-templates';

/**
 * Unix template for sonar-secrets PreToolUse hook targeting OpenAI Codex (Bash tool only).
 * See https://developers.openai.com/codex/hooks — PreToolUse matcher is the tool name (`Bash`).
 */
export function getCodexSecretPreToolTemplateUnix(): string {
  const sonarBlock = bashSonarResolveBlock();
  return String.raw`#!/bin/bash
# PreToolUse (Codex): scan Bash command string before execution for accidental secrets.

${sonarBlock}

stdin_data=$(cat)
tool_name=$(echo "$stdin_data" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)

if [[ "$tool_name" != "Bash" ]]; then
  exit 0
fi

command_text=""
if command -v jq &> /dev/null; then
  command_text=$(printf '%s' "$stdin_data" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
fi
if [[ -z "$command_text" ]]; then
  command_text=$(echo "$stdin_data" | sed -n 's/.*"tool_input"[[:space:]]*:[[:space:]]*{[[:space:]]*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
fi

if [[ -z "$command_text" ]]; then
  exit 0
fi

temp_file=$(mktemp -t 'sonarqube-cli-codex-pretool.XXXXXX')
trap "rm -f $temp_file" EXIT
printf '%s' "$command_text" > "$temp_file"

"$SONAR" analyze secrets "$temp_file" > /dev/null 2>&1
exit_code=$?

if [[ $exit_code -eq 51 ]]; then
  reason="Sonar detected secrets in proposed Bash command"
  printf '%s\n' "sonar-secrets: blocked Bash command (secrets detected). Redact and retry." >&2
  if command -v jq &> /dev/null; then
    jq -n \
      --arg reason "$reason" \
      --arg sm "Sonar blocked this Bash command because the command text may contain secrets. Redact tokens or keys and try again." \
      '{systemMessage: $sm, hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}}'
  else
    echo '{"systemMessage":"Sonar blocked this Bash command because the command text may contain secrets. Redact tokens or keys and try again.","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Sonar detected secrets in proposed Bash command"}}'
  fi
  exit 0
fi

exit 0
`;
}

/**
 * UserPromptSubmit for Codex: blocks via exit code 2 + stderr message.
 * Per https://developers.openai.com/codex/hooks — "exit with code 2 and write the blocking reason
 * to stderr" is the documented mechanism that both blocks the prompt AND surfaces a user-visible
 * message in the Codex App UI. The `decision:"block"` JSON approach does not surface the reason
 * visibly in the Codex App.
 */
export function getCodexSecretPromptTemplateUnix(): string {
  const sonarBlock = bashSonarResolveBlock();
  return String.raw`#!/bin/bash
# UserPromptSubmit (Codex): scan prompt for secrets before sending

${sonarBlock}

stdin_data=$(cat)
# Codex: .payload.prompt or .payload.message — see https://developers.openai.com/codex/hooks
if command -v jq &> /dev/null; then
  prompt=$(printf '%s' "$stdin_data" | jq -r '.prompt // .payload.prompt // .payload.message // .message // empty' 2>/dev/null || true)
else
  prompt=$(echo "$stdin_data" | sed -n 's/.*"prompt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
fi

if [[ -z "$prompt" ]]; then
  exit 0
fi

temp_file=$(mktemp -t 'sonarqube-cli-codex-prompt.XXXXXX')
trap "rm -f $temp_file" EXIT

printf '%s' "$prompt" > "$temp_file"

"$SONAR" analyze secrets "$temp_file" > /dev/null 2>&1
exit_code=$?

if [[ $exit_code -eq 51 ]]; then
  printf '%s\n' "Sonar blocked this prompt: secrets detected. Redact tokens or keys and retry." >&2
  exit 2
fi

exit 0
`;
}

/**
 * PostToolUse for Codex: run SQAA after Bash commands by inspecting the Codex Bash payload.
 * Codex currently emits Bash-only Pre/PostToolUse events, so we infer candidate files from the
 * command text and, if needed, fall back to modified files in the current git worktree.
 */
export function getCodexSqaaPostToolTemplateUnix(projectKey: string): string {
  const sonarBlock = bashSonarResolveBlock();
  const resolvedPathFromRepoRoot = '${resolved_path#$repo_root/}';
  const filesToAnalyzeAppend = '${files_to_analyze}${rel_path}\\n';
  const combinedOutputSeparator = '${combined_output}\\n\\n';
  const combinedOutputAppend = '${combined_output}${rel_path}:\\n${output}';
  return String.raw`#!/bin/bash
# PostToolUse (Codex): run SQAA on files touched by a Bash command.

${sonarBlock}

stdin_data=$(cat)

if command -v jq &> /dev/null; then
  tool_name=$(printf '%s' "$stdin_data" | jq -r '.tool_name // empty' 2>/dev/null || true)
  session_cwd=$(printf '%s' "$stdin_data" | jq -r '.cwd // empty' 2>/dev/null || true)
  command_text=$(printf '%s' "$stdin_data" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
else
  tool_name=$(echo "$stdin_data" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  session_cwd=$(echo "$stdin_data" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  command_text=$(echo "$stdin_data" | sed -n 's/.*"tool_input"[[:space:]]*:[[:space:]]*{[[:space:]]*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
fi

if [[ "$tool_name" != "Bash" ]]; then
  exit 0
fi

if [[ -z "$session_cwd" ]]; then
  session_cwd="$PWD"
fi

session_cwd=$(cd "$session_cwd" 2>/dev/null && pwd -P)
if [[ -z "$session_cwd" ]]; then
  exit 0
fi

repo_root=$(git -C "$session_cwd" rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$repo_root" ]]; then
  exit 0
fi
repo_root=$(cd "$repo_root" 2>/dev/null && pwd -P)

candidate_files=""
if [[ -n "$command_text" ]]; then
  candidate_files=$(printf '%s\n' "$command_text" | grep -oE '([./A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+' | awk '!seen[$0]++' || true)
fi

files_to_analyze=""
while IFS= read -r candidate; do
  [[ -z "$candidate" ]] && continue
  if [[ "$candidate" == /* ]]; then
    resolved_path="$candidate"
  else
    resolved_path="$session_cwd/$candidate"
  fi
  if [[ -f "$resolved_path" ]] && [[ "$resolved_path" == "$repo_root/"* ]]; then
    rel_path="${resolvedPathFromRepoRoot}"
    files_to_analyze="${filesToAnalyzeAppend}"
  fi
done <<< "$candidate_files"

if [[ -z "$files_to_analyze" ]]; then
  files_to_analyze=$(git -C "$repo_root" status --porcelain --untracked-files=all 2>/dev/null | sed -E 's/^.. //' | awk '!seen[$0]++' | head -20)
fi

if [[ -z "$files_to_analyze" ]]; then
  exit 0
fi

combined_output=""
processed=0
while IFS= read -r rel_path; do
  [[ -z "$rel_path" ]] && continue
  abs_path="$repo_root/$rel_path"
  if [[ ! -f "$abs_path" ]]; then
    continue
  fi

  processed=$((processed + 1))
  if [[ $processed -gt 5 ]]; then
    break
  fi

  output=$("$SONAR" analyze sqaa --file "$abs_path" --project ${projectKey} 2>/dev/null || true)
  if [[ -z "$output" ]]; then
    continue
  fi

  if [[ -n "$combined_output" ]]; then
    combined_output="${combinedOutputSeparator}"
  fi
  combined_output="${combinedOutputAppend}"
done <<< "$(printf '%b' "$files_to_analyze")"

if [[ -z "$combined_output" ]]; then
  exit 0
fi

escaped=$(printf '%s' "$combined_output" | awk 'BEGIN{ORS=""} {gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r"); if(NR>1) printf "\\n"; print}')

printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' "$escaped"

exit 0
`;
}
