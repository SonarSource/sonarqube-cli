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

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { ScaClient, type ScaEnablement } from '@/core/server/sca.ts';
import {
  resolveVortexEntitlement,
  type VortexEntitlementStatus,
} from '@/core/vortex/entitlement.ts';

/** Same status vocabulary `sonar system status` reports, so the two commands describe
 *  entitlement the same way instead of `sonar stats` collapsing it into its own booleans. */
export interface StatsEntitlement {
  vortex: VortexEntitlementStatus;
  sca: ScaEnablement | 'not_applicable';
}

const NO_CONNECTION_ENTITLEMENT: StatsEntitlement = {
  vortex: 'not_applicable',
  sca: 'not_applicable',
};

/** Resolves the Vortex/SCA entitlement status backing `sonar stats`'s upsell placeholders.
 *  Without an active connection there is nothing to check against, so both statuses report
 *  `not_applicable` rather than a value implying a check that never ran. */
export async function resolveStatsEntitlement(
  ctx: CommandInvocationContext,
): Promise<StatsEntitlement> {
  const connection = await ctx.resolveConnection({ silent: true });
  if (!connection) return NO_CONNECTION_ENTITLEMENT;

  const client = new ScaClient(connection.httpClient);
  const [vortex, sca] = await Promise.all([
    resolveVortexEntitlement(connection),
    client.getScaEnablement(connection.auth.connectionType, connection.auth.orgKey).orThrow(),
  ]);

  return { vortex: vortex.status, sca };
}
