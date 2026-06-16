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

// Integrate command — setup SonarQube integration for Cursor.

import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import { warn } from '../../../../ui';
import {
  displayAgentIntegratePrelude,
  finalizeAgentInstall,
} from '../_common/agent-integrate-prelude';
import { resolveSqaaSetup } from '../_common/sqaa-entitlement';
import type { IntegrateAgentOptions } from '../_common/types';
import { CURSOR_INTEGRATION_ID, type CursorIntegrationOptions } from './declaration';

export async function integrateCursor(
  options: IntegrateAgentOptions,
  auth: ResolvedAuth,
): Promise<void> {
  const ctx = await displayAgentIntegratePrelude('Cursor', 'cursor', options, auth);

  if (ctx.isGlobal) {
    warn(
      "Cursor's cloud/background agents only pick up project-level hooks, not global ones. Re-run without --global from a project directory for full hook coverage.",
    );
  }

  // SQAA is always project-scoped. resolveSqaaSetup owns the user-facing
  // messaging (promotion when not entitled, "not supported with --global" on an
  // entitled global install); its result decides whether the always-applied
  // SonarQube Agentic Analysis rule is written. Context Augmentation is resolved
  // inside finalizeAgentInstall (the install tail shared with the other agents).
  const sqaaEligible = await resolveSqaaSetup({
    serverURL: ctx.serverUrl,
    token: ctx.token,
    organization: ctx.organization,
    isGlobal: ctx.isGlobal,
  });

  await finalizeAgentInstall<CursorIntegrationOptions>({
    integrationId: CURSOR_INTEGRATION_ID,
    context: ctx,
    options,
    auth,
    featureOptions: { installSqaaInstructions: sqaaEligible && Boolean(ctx.projectKey) },
  });
}
