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
import {
  SonarQubeClient,
  type VortexEntitlementResult,
  type VortexEntitlementStatus,
} from '@/core/server/client.ts';

/** Shared low-level call: every entitlement lookup in this file goes through here. */
async function queryVortexEntitlement(auth: ResolvedAuth): Promise<VortexEntitlementResult> {
  return new SonarQubeClient(auth.serverUrl, auth.token).hasVortexEntitlement(auth.orgKey);
}

/**
 * Re-query the combined Vortex entitlement for the resolved connection. Used to
 * reinterpret a runtime 403 (entitlement loss vs usage-limit exhaustion) without
 * coupling to any command or output layer.
 */
export async function recheckVortexEntitlement(
  auth: ResolvedAuth,
): Promise<VortexEntitlementStatus> {
  const { status } = await queryVortexEntitlement(auth);
  return status;
}

/**
 * `not_applicable` is decided here for connections that cannot ask the Hub at all
 * (unauthenticated, or Cloud without an organization). Server connections are
 * queried: a missing Hub returns `not_applicable` from the 404, distinct from a
 * real `not_entitled` licence refusal. Cloud vs Server follows the URL
 * (`isSonarQubeCloud`), same as `SonarQubeClient`, not the stored connection type.
 */
export async function resolveVortexEntitlement(
  auth: ResolvedAuth | null,
): Promise<VortexEntitlementResult> {
  if (!auth) {
    return { status: 'not_applicable' };
  }
  if (isSonarQubeCloud(auth.serverUrl) && !auth.orgKey) {
    return { status: 'not_applicable' };
  }
  return queryVortexEntitlement(auth);
}

export function isVortexEntitlementLoss(
  vortexEntitlement: VortexEntitlementResult,
  vortexInstalled: boolean,
): boolean {
  return vortexInstalled && vortexEntitlement.status === 'not_entitled';
}
