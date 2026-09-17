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
  IntegrationContext,
  IntegrationInvocation,
  SubfeatureDeclaration,
} from '@/core/framework/features';
import { askUser, install, skip, uninstall } from '@/core/framework/features';
import { wholeFileRemover } from '@/core/framework/resources';
import type { SonarConnection } from '@/core/server/connection.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { ScaClient } from '@/core/server/sca.ts';
import type { InstalledIntegrationFeature } from '@/core/state/state.ts';
import type { Console } from '@/core/ui/console.ts';
import { resolveVortexEntitlement } from '@/core/vortex/entitlement.ts';

import { isContextAugmentationSkipped } from './context-augmentation.ts';
import { VORTEX_FEATURE_BENEFIT, VORTEX_FEATURE_PREVIEW } from './feature-constants.ts';
import type { IntegrateAgentOptions, VortexDisposition } from './types.ts';

export const VORTEX_FEATURE_ID = 'vortex';
export const CONTEXT_AUGMENTATION_SKILL_RESOURCE_ID = 'context-augmentation-skill-file'; // retired, removal only

export function isVortexFeature(feature: InstalledIntegrationFeature): boolean {
  return feature.featureId === VORTEX_FEATURE_ID;
}

/**
 * Builds an agent's Vortex container from the capabilities it supports. The
 * subfeature ids are the ids those capabilities had as standalone features, so
 * `replacedIds` migrates installs recorded before the unification into this one.
 *
 * Declare this feature *before* any sibling top-level feature that reads its
 * outcome via `vortexInstallDecision` (e.g. Claude's `PostToolUse` dispatch
 * container — see that function's doc comment) — `shouldInstall` here is the
 * one place that actually asks the user, and siblings need that resolved
 * answer to already exist in `invocation.resolvedFeatureDecisions`.
 */
export function createVortexFeature<TOptions extends IntegrateAgentOptions>(
  subfeatures: SubfeatureDeclaration<TOptions>[],
  legacyCagSkillPath: (context: IntegrationContext) => string,
): FeatureContainer<TOptions> {
  const subfeatureIds = subfeatures.map((subfeature) => subfeature.id);

  return {
    id: VORTEX_FEATURE_ID,
    displayName: 'Vortex',
    benefitDescription: VORTEX_FEATURE_BENEFIT,
    previewDescription: VORTEX_FEATURE_PREVIEW,
    shouldInstall: vortexShouldInstall,
    replacedIds: subfeatureIds,
    defaultInstallSubfeatureIds: subfeatureIds,
    legacyCleanups: [
      wholeFileRemover({
        id: CONTEXT_AUGMENTATION_SKILL_RESOURCE_ID,
        targetPath: legacyCagSkillPath,
      }),
    ],
    subfeatures,
  };
}

function vortexShouldInstall<TOptions extends IntegrateAgentOptions>({
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

export const VORTEX_OVER_CONSUMPTION_MESSAGE =
  'The Vortex usage limit has been reached. Installing it anyway — Vortex will resume once usage resets.';

export const VORTEX_SCA_CHECK_FAILED_MESSAGE =
  'Could not verify SCA availability on the connected server. Proceeding with SCA disabled in the generated skill content.';

export interface ResolvedVortexSetup {
  disposition: VortexDisposition;
  scaEnabled?: boolean;
}

/**
 * Install decision for anything gated on Vortex *other than* the `vortex`
 * container's own top-level feature (that one is `vortexShouldInstall`,
 * above — it's the one that actually asks).
 *
 * Prefers the `vortex` feature's own resolved outcome from
 * `invocation.resolvedFeatureDecisions` over raw `vortexDisposition` so a
 * sibling top-level feature evaluated later in the same integration's
 * `features` array (Claude's `PostToolUse`/SQAA hook dispatch container is
 * the one case that needs this — see `createClaudeHookEventContainer`)
 * agrees with whatever the umbrella feature's Keep/Remove ask just resolved
 * to, instead of independently re-deriving from entitlement alone and
 * silently reinstalling something the user just declined. A subfeature of
 * the `vortex` container itself (the common case) always finds this
 * populated too, since subfeatures only evaluate after their own
 * container's decision does. Falls back to raw disposition only when
 * nothing has resolved 'vortex' yet in this invocation (shouldn't happen
 * given the declaration-order requirement above, but fails toward the
 * pre-existing entitlement-only behavior rather than crashing).
 */
export function vortexInstallDecision<TOptions extends IntegrateAgentOptions>(
  invocation: Pick<IntegrationInvocation<TOptions>, 'options' | 'resolvedFeatureDecisions'>,
): InstallDecision {
  const resolved = invocation.resolvedFeatureDecisions?.get(VORTEX_FEATURE_ID);
  if (resolved === 'install') {
    return install();
  }
  // A first-time 'declined' answer means Vortex itself was never installed —
  // but a sibling like Claude's PostToolUse container can still hold a stale
  // record from before this fix (or any other drift), so treat it the same
  // as 'uninstall' to tear that down. `uninstall()` is already a no-op with
  // no message when the sibling was never installed (selection.ts).
  if (resolved === 'uninstall' || resolved === 'declined') {
    return uninstall();
  }
  if (resolved === 'skip') {
    return skip();
  }
  return vortexInstallDecisionFromDisposition(invocation.options.vortexDisposition);
}

function vortexInstallDecisionFromDisposition(
  disposition: VortexDisposition | undefined,
): InstallDecision {
  if (disposition === 'install') {
    return install();
  }
  if (disposition === 'remove') {
    return uninstall();
  }
  return skip();
}

async function resolveScaEnabled(
  { auth, httpClient }: SonarConnection,
  isServer: boolean,
  console: Console,
): Promise<boolean> {
  const client = new ScaClient(httpClient);
  const scaStatus = await client
    .getScaEnablement(isServer ? 'on-premise' : 'cloud', auth.orgKey)
    .orThrow();
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
  auth: ResolvedAuth,
  console: Console,
): Promise<ResolvedVortexSetup> {
  const connection: SonarConnection = {
    auth,
    httpClient: new SonarHttpClient(auth.serverUrl, auth.token),
  };
  const { status } = await resolveVortexEntitlement(connection);
  const isServer = !isSonarQubeCloud(auth.serverUrl);
  const settled = (disposition: VortexDisposition): ResolvedVortexSetup => ({ disposition });

  if (status === 'not_applicable') {
    console.info(isServer ? VORTEX_SERVER_UNAVAILABLE_MESSAGE : VORTEX_PROMOTION_MESSAGE);
    return settled('remove');
  }

  if (status === 'check_failed' || status === 'organization_not_accessible') {
    console.warn(VORTEX_CHECK_FAILED_MESSAGE);
    return settled('preserve');
  }
  if (status === 'not_entitled') {
    console.info(isServer ? VORTEX_SERVER_NOT_ENTITLED_MESSAGE : VORTEX_PROMOTION_MESSAGE);
    return settled('remove');
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
    scaEnabled: await resolveScaEnabled(connection, isServer, console),
  };
}
