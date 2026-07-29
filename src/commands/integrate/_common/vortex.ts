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

import { AGENTIC_ANALYSIS_DOCS_URL } from '@/core/config-constants.ts';
import type { FeatureContainer, SubfeatureDeclaration } from '@/core/framework/features';
import { askUser, skip } from '@/core/framework/features';
import { isSonarQubeCloud, type ResolvedAuth } from '@/core/host/auth-resolver.ts';
import { SonarQubeClient } from '@/core/server/client.ts';
import type { InstalledIntegrationFeature } from '@/core/state/state.ts';
import { info, warn } from '@/core/ui';

import { isContextAugmentationSkipped } from './context-augmentation.ts';
import { VORTEX_FEATURE_BENEFIT, VORTEX_FEATURE_PREVIEW } from './feature-constants.ts';

export const VORTEX_FEATURE_ID = 'vortex';

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

export const VORTEX_PROMOTION_MESSAGE = `Vortex is available on SonarQube Cloud. Learn more: ${AGENTIC_ANALYSIS_DOCS_URL}`;

export const VORTEX_CHECK_FAILED_MESSAGE = 'Could not determine Vortex entitlement — skipping.';

export const VORTEX_GLOBAL_SKIP_MESSAGE =
  'Skipping Vortex: not supported with --global. Re-run without --global from a project directory to install it there.';

export const VORTEX_MISSING_PROJECT_MESSAGE =
  'Skipping Vortex: a project key and organization are required (configure your project or pass --project).';

export const VORTEX_OVER_CONSUMPTION_MESSAGE =
  'Your organization has reached its Vortex usage limit. Installing it anyway — Vortex will resume once your usage resets.';

export const VORTEX_SCA_CHECK_FAILED_MESSAGE =
  'Could not verify SCA availability on the connected server. Proceeding with SCA disabled in the generated skill content.';

export interface ResolveVortexSetupParams {
  auth: ResolvedAuth;
  projectKey: string | undefined;
  isGlobal: boolean;
}

export interface ResolvedVortexSetup {
  scaEnabled: boolean;
}

/**
 * One entitlement check for all Vortex capabilities, resolving whether the
 * Vortex feature can be installed and the SCA flag its content depends on.
 */
export async function resolveVortexSetup(
  params: ResolveVortexSetupParams,
): Promise<ResolvedVortexSetup | null> {
  if (!isSonarQubeCloud(params.auth.serverUrl)) {
    info(VORTEX_PROMOTION_MESSAGE);
    return null;
  }

  const client = new SonarQubeClient(params.auth.serverUrl, params.auth.token);
  const status = await client.hasVortexEntitlement(params.auth.orgKey);

  if (status === 'check_failed') {
    warn(VORTEX_CHECK_FAILED_MESSAGE);
    return null;
  }
  if (status === 'not_entitled') {
    info(VORTEX_PROMOTION_MESSAGE);
    return null;
  }
  if (params.isGlobal) {
    warn(VORTEX_GLOBAL_SKIP_MESSAGE);
    return null;
  }
  if (!params.projectKey || !params.auth.orgKey) {
    warn(VORTEX_MISSING_PROJECT_MESSAGE);
    return null;
  }
  if (status === 'over_consumption') {
    warn(VORTEX_OVER_CONSUMPTION_MESSAGE);
  }

  if (isContextAugmentationSkipped()) {
    return { scaEnabled: false };
  }

  // The rendered context augmentation skill advertises
  // SCA tools only when SCA is available on the connection.
  const scaStatus = await client.getScaEnablement(params.auth.connectionType, params.auth.orgKey);
  if (scaStatus === 'check_failed') {
    warn(VORTEX_SCA_CHECK_FAILED_MESSAGE);
  }

  return { scaEnabled: scaStatus === 'enabled' };
}
