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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { vortexUnavailableHookMessage } from '@/core/vortex/availability-messages.ts';
import { recheckVortexEntitlement } from '@/core/vortex/entitlement.ts';
import {
  isVortexEntitlementLossNoticeDue,
  recordVortexEntitlementLossWarned,
} from '@/core/vortex/vortex-entitlement-notice.ts';

import { writePostToolUseHookOutput } from './format-sqaa-hook-context.ts';

/** Returns whether a message was written, so dispatcher-based callers can report `handled` accurately. */
export async function emitVortexUnavailableHookNotice(auth: ResolvedAuth): Promise<boolean> {
  // The timestamp is written only for `not_entitled`, which in a hook means the org's
  // trial ended — a sticky state that will not become `over_consumption` within the
  // cooldown. So a fresh timestamp lets us skip the re-check network calls entirely
  // rather than spend them to stay silent.
  if (!isVortexEntitlementLossNoticeDue()) {
    return false;
  }
  const status = await recheckVortexEntitlement(auth);
  const message = vortexUnavailableHookMessage(status);
  if (!message) {
    return false;
  }
  writePostToolUseHookOutput(message);
  if (status === 'not_entitled') {
    recordVortexEntitlementLossWarned();
  }
  return true;
}
