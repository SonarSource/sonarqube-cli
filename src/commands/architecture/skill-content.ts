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
description: Read current or intended architecture and apply user-specified intended-model edits through the Sonar CLI or MCP. The write replaces the complete intended model; omitted content is removed. Not for architecture recommendations, diagnosis or code navigation.
---
${ARCHITECTURE_SKILL_MARKER}

# Architecture data operations

Read requested architecture data or apply explicitly specified intended-model edits. Return the
requested data, operation result and any reported limits or errors. Architectural diagnosis,
model design, refactoring recommendations and code navigation belong outside this core skill.
Do not infer groups or constraints, choose a dependency to remove, or orchestrate other analysis
tools.

## Discover the installed interface

Use the installed CLI help or the exposed MCP tool definitions to discover supported operations,
parameters, defaults and availability. In CLI Alpha, enable \`SONARQUBE_CLI_ALPHA=true\` and start
with \`sonar architecture --help\`. The skill is installed as a local copy; use the installed
interface as the authority for syntax.

Use the configured connection and organization. Resolve the project from the user's request or
integration configuration; ask if it is unknown. Use component references returned by reads.
Only the public Architecture API is supported. Report request failures; do not try private
endpoints or an API mode switch.

## Read within context limits

Read only the scope the user requests. For current architecture, use only the bounded CLI or MCP
read operations. The clients cap the nodes returned before exposing the response to the agent;
this is a node limit, not an absolute token budget. Preserve returned limits, omissions,
truncation and partial-view warnings.

Do not bypass those limits by fetching raw current-graph endpoints, requesting an unbounded
graph, or assembling all slices into the agent context. Use a specific bounded slice when more
detail is needed. Reported dependencies are static references, not runtime calls.

This current-graph cap does not apply to complete intended exports. Keep large intended exports
in local files rather than pasting them into the conversation. Never substitute a partial view
when a complete export is required for a write.

## Intended-model edits

The write replaces the complete intended model; omitted content is removed.

1. Obtain the complete intended export without component, depth or language filters. Retain all
   perspectives and the exported revision as the base for the edit.
2. Apply only the edits the user specified. If groups, patterns or constraints are unspecified,
   ask for them rather than designing a model.
3. Use the installed interface to validate and preview without writing. Retain the whole export
   and its revision; a revision supplied separately must match the exported one.
4. Show the returned diff and warnings. Apply only after the user confirms that preview, using
   exactly the approved model and revision.
5. Read the saved intended architecture to verify the result. It takes effect from the project's
   next analysis.

Never use partial or truncated input, discard perspectives to fit the API, or remove a revision
to bypass a conflict. On a stale revision, read again and reapply only the specified edits before
a new preview and confirmation.

The clients write the complete set of language/type perspectives. Failed writes are checked
by a read and are never automatically rolled back. A concurrent change after preflight can
still race the write. Public exports flatten imported organization patterns and omit metadata,
so replacement and restoration cannot preserve those links or omitted metadata. Include these
returned warnings when presenting the preview.

If an operation fails, report the error and inspect the saved state before retrying. CLI writes
save a local backup; MCP errors can include the previous export. Preserve that export and the
recovery instructions, inspect the current state, and obtain approval before restoring it.

## Availability

Intended operations on SonarQube Server await public project UUID resolution. Deviations,
structural flaws and architecture coverage are not exposed by these adapters in this iteration. Do not call
unavailable operations, claim their results or substitute other analysis tools.
`;
