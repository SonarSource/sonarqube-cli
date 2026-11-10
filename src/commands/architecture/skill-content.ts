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

/** Identifies the Sonar-managed architecture skill for safe updates. */
export const ARCHITECTURE_SKILL_MARKER = '<!-- sonar:architecture-skill -->';

export const ARCHITECTURE_SKILL = `---
name: sonar-architecture
description: Read current or intended architecture, project directives, deviations, flaws and smells; apply specified intended edits or create, update and delete specified directives through the Sonar CLI or MCP. The write replaces the complete intended model; omitted content is removed. Not for architecture recommendations, diagnosis or code navigation.
---
${ARCHITECTURE_SKILL_MARKER}

# Architecture data operations

Read requested architecture data, including read-only findings (deviations, flaws and smells), apply explicitly specified intended-model edits, or create, update and delete explicitly specified project directives. Return the
requested data, operation result and any reported limits or errors. Architectural diagnosis,
model design, refactoring recommendations and code navigation belong outside this core skill.
Do not infer groups or constraints, choose a dependency to remove, or orchestrate other analysis
tools.

## Discover the installed interface

Use the installed CLI help or the exposed MCP tool definitions to discover supported operations,
parameters, defaults and availability. Start with \`sonar architecture --help\`; the installed
interface is the authority for syntax. The skill is installed as a local copy.

Authenticate with the CLI before installing or using the skill. Use the configured connection and organization. Resolve the project from the user's request or
integration configuration; ask if it is unknown. Use component references returned by reads.
Only the public Architecture API is supported. Report request failures; do not try private
endpoints or an API mode switch.

## Read within context limits

Read only the scope the user requests. For current architecture, use only the bounded CLI or MCP
read operations. The clients cap nodes, dependencies and feedback pairs before exposing the response to the agent;
this is a node limit, not an absolute token budget. Preserve returned limits, omissions,
truncation and partial-view warnings.

Do not bypass those limits by fetching raw current-graph endpoints, requesting an unbounded
graph, or assembling all slices into the agent context. Use a specific bounded slice when more
detail is needed. Reported dependencies are static references, not runtime calls.

To inspect a dependency between two known components, use current get with both --from and
--to. Use MCP only when its installed architecture_get definition lists from, to, pageIndex and
pageSize; otherwise use the CLI. These are exact keys including descendants; do not combine
with component. Depth 1 groups by the endpoints' direct children and preserves leaf endpoints;
increase depth or select a returned pair for detail. Ancestor/descendant aggregate rows are omitted;
increase depth to inspect their internal dependencies. Results are directional static dependencies,
not runtime calls. Use --page/--page-size (MCP: pageIndex/pageSize, when documented by the installed
tool) to continue the selected query,
with at most 20 rows per page. Compare revision across pages and restart if it changes. Specify
language if the pair is ambiguous. Only retrieve pages relevant to the user's question, not the
whole project graph. Container-level relationship graphs are explicitly unsupported by this mode.

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

When the user asks to reproduce a physical package or folder hierarchy, first inspect bounded
current slices to obtain the real artifact keys, separators and intermediate parents. Keep the
complete ancestor chain, and follow a single-child chain to its branching point as the UI does.
For example, under \`gctoolkit-parser\`, put \`jvm\` and \`unified\` inside the shared
\`com.microsoft.gctoolkit.parser\` group, rather than adding full package names as flat siblings.
Use the artifact's child separator followed by \`**\` to select a container's descendants
(e.g. \`gctoolkit-parser:com.microsoft.gctoolkit.parser.**\`). Exact leaf patterns are valid;
never append \`**\` blindly. Preserve discovery-binding patterns alongside renamed/moved
intended patterns. Keep user-requested logical groupings; do not normalize them into a physical
tree. If a physical mapping is ambiguous or the necessary artifacts are unavailable, ask before
constructing it. The clients report discovery-backed warnings without moving groups or rewriting
patterns. An unavailable discovery check is not proof that a pattern matches.

Constraint endpoints name full intended group keys, not discovery component keys. Check both
endpoints against the same perspective. Self-references and nonexistent or ambiguous exact keys
are rejected. Public wildcard selectors and descendants of imported patterns remain server-resolved.

Clearing a stored intended resource requires its exported revision; preview it before applying.
Never use partial or truncated input, discard perspectives to fit the API, or remove a revision
to bypass a conflict. On a stale revision, read again and reapply only the specified edits before
a new preview and confirmation.

The clients write the complete set of language/type perspectives. Failed writes are checked
by a read and are never automatically rolled back. A concurrent change after preflight can
still race the write. Preserve public labels, descriptions and patternId import links. The server resolves linked
groups; submitted expanded children do not replace the referenced pattern. Unknown fields omitted
by the public export cannot be preserved. Include these
returned warnings when presenting the preview.

If an operation fails, report the error and inspect the saved state before retrying. CLI writes
save a local backup; MCP errors can include the previous export. Recovery exports keep patternId
and omit its resolved children, which remain managed by the server. Preserve that export and the
recovery instructions, inspect the current state, and obtain approval before restoring it.

## Project directives

Read directives a page at a time and retain the pagination metadata. Use exact keys for existing
nodes from current reads; take the proposed destination or new name from the user. Do not infer
a move, rename or dependency removal.

Each directive requires type (REMOVE_EDGE, RENAME_NODE or MOVE_NODE), ecosystem, graphType
(file_graph or namespace_graph), fromNodeKey and toNodeKey. Optional: graphPerspective and
description. Returned IDs are not sent in create requests. The CLI records sonarqube-cli as the
origin of new directives instead of copying an exported origin.

For MOVE_NODE, toNodeKey is the exact key of an existing destination container, not the moved
node's future key. The backend appends the source node's name. For RENAME_NODE, toNodeKey is
the full new key, not only the new label. REMOVE_EDGE uses two existing endpoint keys.
If a MOVE_NODE destination is reported missing, re-read the current architecture and ask the
user to choose an existing destination; do not treat it as a new location to create.

Preview first, show what would be created and skipped, and apply only after the user confirms.
When graphPerspective is omitted, creation uses default_perspective. Preview warns about keys missing
from the current graph; review these warnings before confirming the write.

Creation is additive: existing directives remain unchanged, and existing or repeated directives
are skipped. Duplicate checks can race concurrent creates.

Use \`sonar architecture directives get --id <id>\` to read one directive. Apply explicit changes with
\`sonar architecture directives set --file <file> [--dry-run]\`. The JSON object contains optional
\`create\`, \`update\` and \`delete\` arrays. Create records contain directive fields; update records
contain \`id\` and changed fields; delete records contain only \`id\`. Omitted fields on updates and
unmentioned directives are retained. Do not turn a paginated read into an implicit replacement.
Use MCP only if the installed \`architecture_set\` definition documents the \`directives\` target and
every requested operation (\`create\`, \`update\`, \`delete\`). Pass the JSON through \`model\`; otherwise use the CLI.
Preview every batch and obtain user confirmation before applying it. Conflicting IDs are rejected
and the whole batch is validated before the first write. Writes are individual, not atomic.
The public API cannot clear optional fields with null and has no conditional writes. On a partial
or uncertain failure, retain confirmed IDs and inspect the targeted directives before retrying;
never repeat a write or roll back automatically.

## Availability

The CLI architecture commands require a SonarQube Cloud connection. Check the installed MCP
tool descriptions for their supported environments.
Architecture coverage is not exposed by these adapters in this iteration. Do not call
unavailable operations, claim their results or substitute other analysis tools.

## Findings

Read deviations, flaws and smells from the latest analysis with \`sonar architecture findings get\`,
optionally \`--category deviation|flaw|smell\`, \`--type <type>\` or \`--language <language>\`.
Every row includes its category, type, language, details and files; findings have no IDs or separate detail lookup.
Findings use the analyzed main branch and are read-only. Use \`--page-size 0\` only to count findings; do not request further count-only pages.
To read findings, use a positive page size. Retain \`pageIndex\`, \`pageSize\` and \`total\` from each response.
Keep the same filters and page size, and increment \`--page\` while \`pageIndex * pageSize < total\`.
A zero total means no findings match the active filters or are visible; it does not establish project access or a clean architecture.
Unsupported future types, languages and deviation reasons are omitted with an explicit skipped count; backend totals and pagination stay unchanged.
Malformed known findings remain errors. Use the last-page hint when the requested page is beyond the end.
`;
