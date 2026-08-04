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

import { VORTEX_PRODUCT_URL } from '@/core/config-constants.ts';
import type { VortexEntitlementStatus } from '@/core/server/client.ts';

/**
 * Usage-limit copy is identical for hooks and commands and must never suggest
 * re-running `sonar integrate` — the org is still entitled, just over its limit.
 */
export const VORTEX_OVER_CONSUMPTION_MESSAGE =
  'Vortex analysis is paused: your organization has reached its usage limit. Analysis will resume once your usage resets.';

const VORTEX_NOT_ENTITLED_HOOK_MESSAGE = `Vortex analysis is no longer available for this organization. Run \`sonar integrate\` to remove the analysis hooks. See ${VORTEX_PRODUCT_URL}`;

const VORTEX_NOT_ENTITLED_COMMAND_MESSAGE = `Vortex analysis is not available for your organization. See ${VORTEX_PRODUCT_URL}`;

/** Shown when the entitlement re-check cannot attribute a Vortex 403 to a known cause. */
const VORTEX_AMBIGUOUS_403_MESSAGE =
  'Vortex analysis is temporarily unavailable. Please try again later.';

/**
 * Maps a re-checked Vortex entitlement status to user-facing copy, given the
 * `not_entitled` message for the calling context. Returns `undefined` for
 * `enabled`/`check_failed`: a 403 that the re-check cannot attribute is
 * ambiguous (transient/racey), so callers skip silently rather than show
 * misleading guidance.
 */
function vortexUnavailableMessage(
  status: VortexEntitlementStatus,
  notEntitledMessage: string,
): string | undefined {
  if (status === 'over_consumption') {
    return VORTEX_OVER_CONSUMPTION_MESSAGE;
  }
  if (status === 'not_entitled') {
    return notEntitledMessage;
  }
  return undefined;
}

/**
 * Vortex analysis 403 copy for a hook.
 */
export function vortexUnavailableHookMessage(status: VortexEntitlementStatus): string | undefined {
  return vortexUnavailableMessage(status, VORTEX_NOT_ENTITLED_HOOK_MESSAGE);
}

/**
 * Vortex analysis 403 copy for a command. Unlike the hook variant, an ambiguous
 * status still gets user-facing copy — commands have no silent-skip fallback.
 */
export function vortexUnavailableCommandMessage(status: VortexEntitlementStatus): string {
  return (
    vortexUnavailableMessage(status, VORTEX_NOT_ENTITLED_COMMAND_MESSAGE) ??
    VORTEX_AMBIGUOUS_403_MESSAGE
  );
}
