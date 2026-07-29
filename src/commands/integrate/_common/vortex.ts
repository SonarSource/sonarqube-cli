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
  FeatureContainer,
  IntegrationContext,
  ResourceDeclaration,
  SubfeatureDeclaration,
} from '@/core/framework/features';
import { askUser, install, skip, textSnippet } from '@/core/framework/features';
import type { InstalledIntegrationFeature } from '@/core/state/state.ts';

import { getRequiredStringAttr } from './attrs.ts';
import { VORTEX_FEATURE_BENEFIT, VORTEX_FEATURE_PREVIEW } from './feature-constants.ts';
import {
  buildSqaaSectionBody,
  sonarBeginMarker,
  sonarEndMarker,
} from './instructions-templates.ts';

export const VORTEX_FEATURE_ID = 'vortex';

export const SQAA_INSTRUCTIONS_SUBFEATURE_ID = 'sqaa-instructions';
const SQAA_INSTRUCTIONS_MARKER = 'sonarqube-agentic-analysis-protocol';

export interface VortexIntegrationOptions {
  projectRoot?: string;
  installVortex?: boolean;
}

/** Vortex is project-scoped, so only these records carry usable project metadata. */
export function isProjectVortexFeature(feature: InstalledIntegrationFeature): boolean {
  return feature.featureId === VORTEX_FEATURE_ID && feature.scope === 'project';
}

/**
 * Builds an agent's Vortex container from the capabilities it supports. The
 * subfeature ids are the ids those capabilities had as standalone features, so
 * `replacedIds` migrates installs recorded before the unification into this one.
 */
export function createVortexFeature<TOptions extends VortexIntegrationOptions>(
  subfeatures: SubfeatureDeclaration<TOptions>[],
): FeatureContainer<TOptions> {
  const subfeatureIds = subfeatures.map((subfeature) => subfeature.id);

  return {
    id: VORTEX_FEATURE_ID,
    displayName: 'Vortex',
    benefitDescription: VORTEX_FEATURE_BENEFIT,
    previewDescription: VORTEX_FEATURE_PREVIEW,
    shouldInstall: ({ options }) => (options.installVortex === true ? askUser() : skip()),
    targetRoot: ({ options, targetRoot }) => options.projectRoot ?? targetRoot,
    scope: 'project',
    replacedIds: subfeatureIds,
    defaultInstallSubfeatureIds: subfeatureIds,
    // No legacyCleanups are needed: the retired standalone features owned the
    // same resources now owned by these subfeatures. Post-update replacement
    // revokes only their state records, then re-applies and adopts the assets.
    subfeatures,
  };
}

/** End-of-turn SQAA instructions, written by each agent into its own rules format. */
export function createSqaaInstructionsSubfeature<TOptions>(
  resources: ResourceDeclaration[],
): SubfeatureDeclaration<TOptions> {
  return {
    id: SQAA_INSTRUCTIONS_SUBFEATURE_ID,
    displayName: 'SQAA instructions',
    shouldInstall: () => install(),
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
    displayName: 'Vortex agentic analysis instructions',
    targetPath,
    startMarker: sonarBeginMarker(SQAA_INSTRUCTIONS_MARKER),
    endMarker: sonarEndMarker(SQAA_INSTRUCTIONS_MARKER),
    content: (context) =>
      buildSqaaSectionBody(getRequiredStringAttr(context, 'projectKey', agentDisplayName)),
  });
}
