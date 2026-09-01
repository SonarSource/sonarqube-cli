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

import { isSonarQubeCloud, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { VORTEX_PRODUCT_URL } from '@/core/config-constants.ts';
import type {
  FeatureContainer,
  InstallDecision,
  IntegrationInvocation,
  SubfeatureDeclaration,
} from '@/core/framework/features';
import { askUser, install, skip, uninstall } from '@/core/framework/features';
import { SonarQubeClient } from '@/core/server/client.ts';
import type { InstalledIntegrationFeature } from '@/core/state/state.ts';
import type { Console } from '@/core/ui/console.ts';
import { TerminalConsole } from '@/core/ui/terminal-console.ts';
import { resolveVortexEntitlement } from '@/core/vortex/entitlement.ts';

import { isContextAugmentationSkipped } from './context-augmentation.ts';
import { VORTEX_FEATURE_BENEFIT, VORTEX_FEATURE_PREVIEW } from './feature-constants.ts';
import type { IntegrateAgentOptions, VortexDisposition } from './types.ts';

export const VORTEX_FEATURE_ID = 'vortex';

/** Vortex is project-scoped, so only these records carry usable project metadata. */
export function isProjectVortexFeature(feature: InstalledIntegrationFeature): boolean {
  return feature.featureId === VORTEX_FEATURE_ID && feature.scope === 'project';
}

/**
 * Builds an agent's Vortex container from the capabilities it supports. The
 * subfeature ids are the ids those capabilities had as standalone features, so
 * `replacedIds` migrates installs recorded before the unification into this one.
 */
export function createVortexFeature<TOptions extends IntegrateAgentOptions>(
  subfeatures: SubfeatureDeclaration<TOptions>[],
): FeatureContainer<TOptions> {
  const subfeatureIds = subfeatures.map((subfeature) => subfeature.id);

  return {
    id: VORTEX_FEATURE_ID,
    displayName: 'Vortex',
    benefitDescription: VORTEX_FEATURE_BENEFIT,
    previewDescription: VORTEX_FEATURE_PREVIEW,
    shouldInstall: vortexShouldInstall,
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

export function vortexShouldInstall<TOptions extends IntegrateAgentOptions>({
  options,
}: IntegrationInvocation<TOptions>): InstallDecision {
  if (options.vortexDisposition === 'install') {
    return askUser();
  }
  if (options.vortexDisposition === 'remove') {
    return uninstall(VORTEX_UNINSTALL_MESSAGE);
  }
  return skip();
}

export const VORTEX_PROMOTION_MESSAGE = `Vortex is not enabled for this organization. Learn more: ${VORTEX_PRODUCT_URL}`;

export const VORTEX_SERVER_UNAVAILABLE_MESSAGE =
  'Vortex requires SonarQube Server 2026.5 Enterprise or later.';

export const VORTEX_SERVER_NOT_ENTITLED_MESSAGE =
  'Vortex is not licensed on this SonarQube Server. Ask your administrator.';

export const VORTEX_UNINSTALL_MESSAGE =
  'Vortex is no longer available. Removing the existing Vortex integration.';

export const VORTEX_CHECK_FAILED_MESSAGE = 'Could not determine Vortex entitlement — skipping.';

export const VORTEX_GLOBAL_SKIP_MESSAGE =
  'Skipping Vortex: not supported with --global. Re-run without --global from a project directory to install it there.';

export const VORTEX_MISSING_PROJECT_MESSAGE =
  'Skipping Vortex: a project key is required (configure your project or pass --project).';

export const VORTEX_MISSING_CLOUD_CONTEXT_MESSAGE =
  'Skipping Vortex: a project key and organization are required (configure your project or pass --project).';

export const VORTEX_OVER_CONSUMPTION_MESSAGE =
  'The Vortex usage limit has been reached. Installing it anyway — Vortex will resume once usage resets.';

export const VORTEX_SCA_CHECK_FAILED_MESSAGE =
  'Could not verify SCA availability on the connected server. Proceeding with SCA disabled in the generated skill content.';

export interface ResolveVortexSetupParams {
  auth: ResolvedAuth;
  projectKey: string | undefined;
  isGlobal: boolean;
}

export interface ResolvedVortexSetup {
  disposition: VortexDisposition;
  scaEnabled?: boolean;
}

/** Maps the container disposition onto a subfeature install decision. */
export function vortexInstallDecision(disposition: VortexDisposition | undefined): InstallDecision {
  if (disposition === 'install') {
    return install();
  }
  if (disposition === 'remove') {
    return uninstall();
  }
  return skip();
}

async function resolveScaEnabled(
  auth: ResolvedAuth,
  isServer: boolean,
  console: Console = new TerminalConsole(),
): Promise<boolean> {
  const client = new SonarQubeClient(auth.serverUrl, auth.token);
  const scaStatus = await client.getScaEnablement(isServer ? 'on-premise' : 'cloud', auth.orgKey);
  if (scaStatus === 'check_failed') {
    console.warn(VORTEX_SCA_CHECK_FAILED_MESSAGE);
  }
  return scaStatus === 'enabled';
}

/**
 * One entitlement check for all Vortex capabilities, resolving whether the
 * Vortex feature can be installed and the SCA flag its content depends on.
 */
export async function resolveVortexSetup(
  params: ResolveVortexSetupParams,
  console: Console = new TerminalConsole(),
): Promise<ResolvedVortexSetup> {
  const { status } = await resolveVortexEntitlement(params.auth);
  const isServer = !isSonarQubeCloud(params.auth.serverUrl);
  const settled = (disposition: VortexDisposition): ResolvedVortexSetup => ({ disposition });

  if (status === 'not_applicable') {
    console.info(isServer ? VORTEX_SERVER_UNAVAILABLE_MESSAGE : VORTEX_PROMOTION_MESSAGE);
    return settled('remove');
  }

  if (status === 'check_failed') {
    console.warn(VORTEX_CHECK_FAILED_MESSAGE);
    return settled('preserve');
  }
  if (status === 'not_entitled') {
    console.info(isServer ? VORTEX_SERVER_NOT_ENTITLED_MESSAGE : VORTEX_PROMOTION_MESSAGE);
    return settled('remove');
  }
  if (params.isGlobal) {
    console.warn(VORTEX_GLOBAL_SKIP_MESSAGE);
    return settled('preserve');
  }
  if (!params.projectKey || (!isServer && !params.auth.orgKey)) {
    console.warn(isServer ? VORTEX_MISSING_PROJECT_MESSAGE : VORTEX_MISSING_CLOUD_CONTEXT_MESSAGE);
    return settled('preserve');
  }
  if (status === 'over_consumption') {
    console.warn(VORTEX_OVER_CONSUMPTION_MESSAGE);
  }

  if (isContextAugmentationSkipped()) {
    return { ...settled('install'), scaEnabled: false };
  }

  // The rendered context augmentation skill advertises
  // SCA tools only when SCA is available on the connection.
  return {
    ...settled('install'),
    scaEnabled: await resolveScaEnabled(params.auth, isServer),
  };
}
