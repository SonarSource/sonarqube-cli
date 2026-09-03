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

import type {
  IntegrationContext,
  ResourceDeclaration,
  SubfeatureDeclaration,
} from '@/core/framework/features';
import { textSnippet, wholeFile } from '@/core/framework/features';

import { sonarBeginMarker, sonarEndMarker } from '../instructions-templates.ts';
import type { IntegrateAgentOptions } from '../types.ts';
import { vortexInstallDecision } from '../vortex.ts';

export const SQAA_HOOK_FEATURE_ID = 'sonar-sqaa-hook';
export const SQAA_INSTRUCTIONS_SUBFEATURE_ID = 'sqaa-instructions';
const SQAA_INSTRUCTIONS_MARKER = 'sonarqube-agentic-analysis-protocol';

export const SQAA_INSTRUCTIONS_BODY = `# Vortex analysis protocol

Vortex analysis is the final confirmation layer at the end of every turn in which you wrote to one or more files in the workspace (create, edit, patch, format — any tool call that changed file contents on disk).

**Trigger:** the moment before you send your final reply for the turn.

When the trigger fires, you **MUST** run Vortex analysis on the full set of files you modified this turn — **one command, not a per-file loop**.

**Preferred:** pass every path you modified this turn in a single invocation (repeat \`--file\` for each path). Use paths **relative to the project root** (e.g. \`src/foo.ts\`). For end-of-turn analysis, **always** pass \`--depth DEEP\` — even when you changed only one file — so cross-file findings are included.

\`\`\`bash
sonar analyze agentic --depth DEEP --file <path/to/file1> --file <path/to/file2>
\`\`\`

**Fallback:** when you cannot reliably list every modified path (e.g. you did not track them, or git state is the only source of truth), use the git change set with DEEP analysis:

\`\`\`bash
sonar analyze agentic --depth DEEP
\`\`\`

Per-edit hooks run faster STANDARD analysis. End-of-turn analysis must always use \`--depth DEEP\` (including a single \`--file\`). Use \`--depth STANDARD\` only for optional faster passes — never for the mandatory end-of-turn run.

Non-negotiable rules:

1. Mid-turn edits do **not** need Vortex analysis — only the final on-disk state matters. Skipping Vortex analysis at end-of-turn is a protocol violation.
2. Run Vortex analysis **before** sending your final reply, marking the task done, or handing control back to the user.
3. If Vortex analysis reports issues on lines you touched in this turn, fix them, then re-run Vortex analysis on the same scope (change set or explicit file list). Repeat until clean (or only pre-existing findings on lines you did not touch remain). Pre-existing findings on untouched lines are out of scope — do not "fix" them unless the user asked.
4. If Vortex analysis is skipped (no SonarQube Cloud connection, or no project configured), state the skip reason to the user once and continue — do not retry.
5. Do not suppress, summarize away, or omit Vortex analysis findings from your reply. Surface them verbatim.
`;

/** End-of-turn SQAA instructions, written by each agent into its own rules format. */
export function createSqaaInstructionsSubfeature<TOptions extends IntegrateAgentOptions>(
  resources: ResourceDeclaration[],
): SubfeatureDeclaration<TOptions> {
  return {
    id: SQAA_INSTRUCTIONS_SUBFEATURE_ID,
    displayName: 'Vortex analysis instructions',
    shouldInstall: ({ options }) => vortexInstallDecision(options.vortexDisposition),
    resources,
  };
}

export function createSqaaInstructionsSnippet(
  targetPath: (context: IntegrationContext) => string,
): ResourceDeclaration {
  return textSnippet({
    id: 'sqaa-instructions-file',
    displayName: 'Vortex analysis instructions',
    targetPath,
    startMarker: sonarBeginMarker(SQAA_INSTRUCTIONS_MARKER),
    endMarker: sonarEndMarker(SQAA_INSTRUCTIONS_MARKER),
    content: SQAA_INSTRUCTIONS_BODY,
  });
}

export function createSqaaInstructionsRule(
  targetPath: (context: IntegrationContext) => string,
  wrapAsRule: (body: string) => string,
): ResourceDeclaration {
  return wholeFile({
    id: 'sqaa-instructions-rule',
    displayName: 'Vortex analysis rule',
    targetPath,
    content: wrapAsRule(SQAA_INSTRUCTIONS_BODY),
  });
}
