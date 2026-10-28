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
import type { IntegrationScope } from '@/core/state/state.ts';

import { sonarBeginMarker, sonarEndMarker } from '../instructions-templates.ts';
import type { IntegrateAgentOptions } from '../types.ts';

export const SQAA_HOOK_FEATURE_ID = 'sonar-sqaa-hook';
export const SQAA_INSTRUCTIONS_SUBFEATURE_ID = 'sqaa-instructions';
export const SQAA_INSTRUCTIONS_GLOBAL_SUBFEATURE_ID = 'sqaa-instructions-global';
const SQAA_INSTRUCTIONS_MARKER = 'sonarqube-agentic-analysis-protocol';

export const SQAA_INSTRUCTIONS_BODY = `# Vortex analysis protocol

These instructions were installed by \`sonar integrate\` at the user's request. Vortex analysis checks the final change set for issues before you reply.

At the end of a turn that changed file contents in the workspace (create, edit, patch, or format), run Vortex analysis before your final reply or handoff. Analyze all files changed in the turn in one command.

Pass each modified path with \`--file\`, relative to the directory you run the command from (for example, \`src/foo.ts\`). Use \`--depth DEEP\` even for one file so the analysis includes cross-file findings.

\`\`\`bash
sonar analyze agentic --depth DEEP --file <path/to/file1> --file <path/to/file2>
\`\`\`

If you cannot reliably list every modified path, analyze the git change set with DEEP depth:

\`\`\`bash
sonar analyze agentic --depth DEEP
\`\`\`

Per-edit hooks use faster STANDARD analysis. The end-of-turn check uses DEEP depth, including when only one file changed.

In a repository with several Sonar projects (a monorepo), the directory you run the command from decides what is analyzed. From the monorepo root, one command analyzes every changed file against the project that owns it. From inside one project, only that project is analyzed: a \`--file\` path outside the current directory is rejected, and changes in other projects are listed as not analyzed. Run the command from a directory that contains every file changed this turn, usually the monorepo root. Files owned by no project are skipped in the change-set report and rejected as \`--file\` paths; leave them out rather than retrying.

After the analysis:

1. If no project is configured, stop analysis attempts for this session. A routine skip needs no mention in the final reply unless the user asks about Vortex analysis. If the user asks for Vortex analysis or configures a project, run the analysis again and report any error.
2. If analysis finds issues on lines you changed this turn, fix them and re-run the same scope. Continue until no touched-line findings remain. Leave findings on untouched lines to their existing owners unless the user asks you to address them.
3. If analysis is skipped for another reason (for example, no SonarQube Cloud connection), state the reason once in your reply and continue without retrying this session.
4. Include any remaining Vortex findings verbatim in your reply.
`;

/** End-of-turn SQAA instructions, written by each agent into its own rules format. */
export function createSqaaInstructionsSubfeature<TOptions extends IntegrateAgentOptions>(
  resources: ResourceDeclaration[],
  onlyScope?: IntegrationScope,
): SubfeatureDeclaration<TOptions> {
  const globalOnly = onlyScope === 'global';

  return {
    id: globalOnly ? SQAA_INSTRUCTIONS_GLOBAL_SUBFEATURE_ID : SQAA_INSTRUCTIONS_SUBFEATURE_ID,
    displayName: 'Vortex analysis instructions',
    required: true,
    isAvailable: (invocation) => ({
      available: onlyScope === undefined || invocation.scope === onlyScope,
    }),
    migrationEligible: () => !globalOnly,
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
