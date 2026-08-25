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

import type { VortexEntitlementResult, VortexEntitlementStatus } from '@/core/server/client.ts';
import { blank, text } from '@/core/ui';
import { isVortexEntitlementLoss } from '@/core/vortex/entitlement.ts';

const VORTEX_STATUS_LABELS: Record<VortexEntitlementStatus, string> = {
  enabled: 'Active',
  over_consumption: 'Active (quota exhausted)',
  not_entitled: 'Not entitled',
  check_failed: 'Unknown (check failed)',
  not_applicable: 'Not available',
};

function formatVortexUsage(consumption: { consumed: number; limit: number }): string {
  const { consumed, limit } = consumption;
  const pct = limit === 0 ? 0 : Math.round((consumed / limit) * 1000) / 10;
  return `${consumed.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} (${pct}%)`;
}

export function buildVortexJson(vortex: VortexEntitlementResult): object {
  if (vortex.status === 'not_applicable') {
    return { applicable: false };
  }
  return {
    applicable: true,
    status: vortex.status,
    ...(vortex.consumption ? { consumption: vortex.consumption } : {}),
  };
}

export function buildVortexRecommendation(
  vortexEntitlement: VortexEntitlementResult,
  vortexInstalled: boolean,
  orgKey: string | undefined,
  isServer: boolean,
): string | undefined {
  if (!isVortexEntitlementLoss(vortexEntitlement, vortexInstalled)) {
    return undefined;
  }
  if (isServer) {
    return "Ask your administrator, or run 'sonar integrate' to remove the Vortex integration";
  }
  const target = orgKey ? ` for organization '${orgKey}'` : '';
  return `Re-enable Vortex${target}, or run 'sonar integrate' to remove the Vortex integration`;
}

export function renderVortexSection(vortex: VortexEntitlementResult): void {
  if (vortex.status === 'not_applicable') {
    return;
  }
  blank();
  text('VORTEX');
  text(`  • Status: ${VORTEX_STATUS_LABELS[vortex.status]}`);
  if (vortex.consumption) {
    text(`  • Usage limit: ${formatVortexUsage(vortex.consumption)}`);
  }
}
