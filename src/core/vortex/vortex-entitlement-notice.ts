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

import logger from '@/core/observability/logger.ts';

import { loadState, saveState, tryLoadState } from '../state/state-manager.ts';
import { isWithinCooldown, ONE_DAY_MS } from '../time/cooldown.ts';

/**
 * True when a Vortex entitlement-loss warning may be shown now — i.e. none was
 * emitted within the last 24h. A missing or unreadable state defaults to due so
 * a first-time (or best-effort-failed) warning is never silently swallowed.
 */
export function isVortexEntitlementLossNoticeDue(): boolean {
  const state = tryLoadState();
  return !isWithinCooldown(state?.config.vortexEntitlementLossNotice?.lastWarnedAt, ONE_DAY_MS);
}

/** Best-effort: a failed write only costs one extra warning, so failures are swallowed. */
export function recordVortexEntitlementLossWarned(): void {
  try {
    const state = loadState();
    state.config.vortexEntitlementLossNotice = { lastWarnedAt: new Date().toISOString() };
    saveState(state);
  } catch (err) {
    logger.debug(`Failed to record Vortex entitlement-loss notice: ${(err as Error).message}`);
  }
}
