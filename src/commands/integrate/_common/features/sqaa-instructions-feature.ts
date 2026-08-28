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
import { textSnippet } from '@/core/framework/features';

import { getRequiredStringAttr } from '../attrs.ts';
import {
  buildSqaaSectionBody,
  sonarBeginMarker,
  sonarEndMarker,
} from '../instructions-templates.ts';
import type { IntegrateAgentOptions } from '../types.ts';
import { vortexInstallDecision } from '../vortex.ts';

export const SQAA_HOOK_FEATURE_ID = 'sonar-sqaa-hook';
export const SQAA_INSTRUCTIONS_SUBFEATURE_ID = 'sqaa-instructions';
const SQAA_INSTRUCTIONS_MARKER = 'sonarqube-agentic-analysis-protocol';

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

export interface SqaaInstructionsSnippetOptions {
  /** Integration name reported when the recorded project key is missing. */
  agentDisplayName: string;
  targetPath: (context: IntegrationContext) => string;
}

export function createSqaaInstructionsSnippet({
  agentDisplayName,
  targetPath,
}: SqaaInstructionsSnippetOptions): ResourceDeclaration {
  return textSnippet({
    id: 'sqaa-instructions-file',
    displayName: 'Vortex analysis instructions',
    targetPath,
    startMarker: sonarBeginMarker(SQAA_INSTRUCTIONS_MARKER),
    endMarker: sonarEndMarker(SQAA_INSTRUCTIONS_MARKER),
    content: (context) =>
      buildSqaaSectionBody(getRequiredStringAttr(context, 'projectKey', agentDisplayName)),
  });
}
