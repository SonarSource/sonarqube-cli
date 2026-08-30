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

import { resolveAuth, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import logger from '@/core/observability/logger.ts';

import { resolvePrivateBetaFlags } from './index.ts';

/**
 * Best-effort auth for Private Beta gating at CLI startup.
 * Failures yield `null` so gated commands stay omitted.
 */
export async function resolveStartupAuth(): Promise<ResolvedAuth | null> {
  try {
    return await resolveAuth({ silent: true });
  } catch (err) {
    logger.debug(`Startup auth resolution failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Entrypoint loader for `createCommandTree({ loadPrivateBetaContext })`:
 * resolve auth, then Private Beta flag decisions for the discovered keys.
 */
export async function loadPrivateBetaContext(flagKeys: readonly string[]): Promise<{
  auth: ResolvedAuth | null;
  flags: Record<string, boolean>;
}> {
  const auth = await resolveStartupAuth();
  const flags = await resolvePrivateBetaFlags(auth, { flagKeys });
  return { auth, flags };
}
