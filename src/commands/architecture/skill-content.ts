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

/** Identifies a SKILL.md written by `sonar architecture install-skill`, which may overwrite it. */
export const ARCHITECTURE_SKILL_MARKER = '<!-- sonar:architecture-skill -->';

export const ARCHITECTURE_SKILL = `---
name: sonar-architecture
description: Read current or intended architecture and apply user-specified intended-model edits through the sonar CLI or SonarQube MCP architecture tools. Use for these data operations, not architecture recommendations, diagnosis or code navigation.
---
${ARCHITECTURE_SKILL_MARKER}

# Architecture data operations

Use this skill to read requested architecture data or apply explicitly specified intended-model
edits. Return the requested data, operation result and any reported limits or errors. Architectural
diagnosis, model design, refactoring recommendations and code navigation belong outside this core
skill, in Vortex. Do not infer groups or constraints, choose a dependency to remove, or orchestrate
other analysis tools.

## Connection and operations

Use the available CLI or MCP integration. The CLI needs \`SONARQUBE_CLI_ALPHA=true\` and
\`sonar auth login\`. Pass \`--project <key>\` unless the repository is linked; MCP uses \`projectKey\`
or its configured default. If the project is unknown, ask for it. Use the configured Cloud
organization, or the MCP integration's standard organization selection when needed.

| Operation | CLI | MCP |
| --- | --- | --- |
| Read current architecture | \`sonar arch get current\` | \`architecture_get target=current\` |
| Read intended architecture | \`sonar arch get intended --format json\` | \`architecture_get target=intended\` |
| Preview specified model edits | \`sonar arch set intended --file intended.json --dry-run\` | \`architecture_set target=intended\`, \`model\`, \`dryRun: true\` |
| Apply specified model edits | \`sonar arch set intended --file intended.json\` | \`architecture_set target=intended\`, \`model\`, \`dryRun: false\` |

\`sonar arch\` is an alias for \`sonar architecture\`. Current and intended reads accept \`--component\`,
\`--depth\` and \`--language\`; MCP uses \`component\`, \`depth\` and \`language\`. Languages are \`java\`,
\`cs\`, \`js\`, \`ts\` and \`py\`. Use the component keys returned by a read. CLI \`--format json\` preserves
exact keys; text output shortens labels. MCP returns JSON.

Read only the scope the user requests. If a component key is needed, obtain it from the returned
data. Preserve \`capped\`, \`omittedNodes\`, \`truncated\`, \`partial\` and \`outsideViewWeight\` information
when returning a limited view. Reported dependencies are static references, not runtime calls.

Only the public Architecture API is supported. Return request failures; do not try private
endpoints or an API mode switch. Intended operations on SonarQube Server await public project
UUID resolution. Directives are not available yet: waiting for public API. Do not call directive
targets or claim to create, read or validate directives.

## Intended-model edits

1. Read the complete intended export, without component, depth or language filters. With the CLI,
   save it using \`sonar arch get intended --format json > intended.json\`.
2. Apply only the model edits the user specified. Keep the export's \`revision\`. If the requested
   groups, patterns or constraints are unspecified, ask for them rather than designing a model.
3. Preview with \`sonar arch set intended --file intended.json --dry-run\`; with MCP, pass the whole
   export as \`model\` and set \`dryRun: true\`. An explicit MCP \`revision\` must match the embedded one.
4. Show the returned diff and warnings. Apply only after the user confirms that preview, using
   the same file or model and revision with dry run disabled.
5. Read the saved intended architecture to verify the result. It takes effect in analysis from
   the project's next analysis.

The write replaces the complete intended model; omitted content is removed. Never use a partial
or truncated view as write input, discard perspectives to fit the API, or remove a revision to
bypass a conflict. On a stale revision, read again and reapply only the specified edits before a
new preview and confirmation. A bare MCP models array lacks the original revision; retain the
whole export instead.

The public API creates one language/type perspective. Changed multi-perspective models are
rejected before writing. Replacement is DELETE followed by POST, not an atomic operation; a
concurrent change after preflight can still race the write. Public exports flatten imported
organization patterns and omit metadata, so replacement and restoration cannot preserve those
links or omitted metadata. Include these returned warnings when presenting the preview.

If an operation fails, report the error and inspect the saved state before retrying. CLI writes
save a local backup; MCP errors can include the previous export. Recovery is best effort and is
attempted only after a read verifies the project is empty. Preserve the reported backup or
previous export and recovery instructions; do not claim restoration succeeded without checking.
`;
