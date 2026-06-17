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

// Shared markdown sections that integrations render into their respective
// instructions files (e.g. Copilot's sonarqube.instructions.md, Codex's
// AGENTS.md). Keeping the wording here means a copy-edit to the agent
// protocol lands in every integration at once.
//
// Every snippet is wrapped via `withSonarMarkers` so that future versions of
// the CLI can locate and replace just the managed region of an existing
// instructions file (i.e. without clobbering anything the user appended
// around it).

/**
 * Wrap a markdown body in stable HTML-comment markers. The `id` must remain
 * unique and stable across CLI versions — it is the only identifier we have
 * for finding and replacing the managed region later.
 */
export function withSonarMarkers(id: string, body: string): string {
  return `${sonarBeginMarker(id)}\n${body.trimEnd()}\n${sonarEndMarker(id)}\n`;
}

export function sonarBeginMarker(id: string): string {
  return `<!-- sonar:begin:${id} -->`;
}

export function sonarEndMarker(id: string): string {
  return `<!-- sonar:end:${id} -->`;
}

export function buildSqaaSectionBody(projectKey: string): string {
  return `# SonarQube Agentic Analysis protocol

SonarQube Agentic Analysis is the final confirmation layer at the end of every turn in which you wrote to one or more files in the workspace (create, edit, patch, format — any tool call that changed file contents on disk).

**Trigger:** the moment before you send your final reply for the turn.

When the trigger fires, you **MUST**:

1. Classify **each file you edited this turn** as \`MAIN\` (production code) or \`TEST\` (test, spec, fixture, or mock), using the file path **and** its role in the change.
2. Run SonarQube Agentic Analysis once with one \`--file\` per edited file and the matching scope suffix:

\`\`\`bash
sonar analyze agentic --project ${projectKey} \\
  --file src/foo.ts:MAIN \\
  --file tests/foo.test.ts:TEST
\`\`\`

Append \`:MAIN\` or \`:TEST\` to every edited file when you can classify it confidently. Omit the suffix only when genuinely unsure (unscoped). If more than 50 files were edited and the command prompts for confirmation, re-run with \`--force\`.

Non-negotiable rules:

1. Mid-turn edits do **not** need SonarQube Agentic Analysis — only the final on-disk state matters. Skipping SonarQube Agentic Analysis at end-of-turn is a protocol violation.
2. Run SonarQube Agentic Analysis **before** sending your final reply, marking the task done, or handing control back to the user.
3. List every file you edited; do not rely on a bare change-set command unless you truly cannot enumerate the files.
4. If SonarQube Agentic Analysis reports issues on lines you touched in this turn, fix them, then re-run the same scoped \`--file\` command. Repeat until the change set is clean (or only pre-existing findings on lines you did not touch remain). Pre-existing findings on untouched lines are out of scope — do not "fix" them unless the user asked.
5. If SonarQube Agentic Analysis is skipped (no SonarQube Cloud connection, or no project configured), state the skip reason to the user once and continue — do not retry.
6. Do not suppress, summarize away, or omit SonarQube Agentic Analysis findings from your reply. Surface them verbatim.
`;
}
