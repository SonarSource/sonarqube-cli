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

// Integrate command — setup SonarQube integration for Codex.

import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import type { IntegrationStateAttribute } from '../../../../lib/state';
import {
  displayAgentIntegratePrelude,
  resolveIntegrateInstallTarget,
} from '../_common/agent-integrate-prelude';
import {
  buildContextAugmentationAttrs,
  resolveContextAugmentationSetup,
} from '../_common/context-augmentation';
import { installIntegration } from '../_common/registry';
import { resolveSqaaSetup } from '../_common/sqaa-entitlement';
import type { IntegrateAgentOptions } from '../_common/types';
import { supportedIntegrations } from '../index.js';
import { CODEX_INTEGRATION_ID, type CodexIntegrationOptions } from './declaration';

export async function integrateCodex(
  options: IntegrateAgentOptions,
  auth: ResolvedAuth,
): Promise<void> {
  const ctx = await displayAgentIntegratePrelude('Codex', 'codex', options, auth);

  // SQAA is always project-scoped. resolveSqaaSetup returns false (and surfaces
  // the consistent skip notice when the org is entitled) on a global install, so
  // here we only install the PostToolUse hook for a project install with a known key.
  const sqaaEligible = await resolveSqaaSetup({
    serverURL: ctx.serverUrl,
    token: ctx.token,
    organization: ctx.organization,
    isGlobal: ctx.isGlobal,
  });
  const includeSqaa = sqaaEligible && Boolean(ctx.projectKey);

  const { installRoot, installScope } = resolveIntegrateInstallTarget(
    ctx.isGlobal,
    ctx.project.rootDir,
  );
  const contextAugmentation = options.skipContext
    ? null
    : await resolveContextAugmentationSetup({
        auth,
        projectKey: ctx.projectKey,
        isGlobal: ctx.isGlobal,
      });
  const integrationOptions = {
    ...options,
    installSqaaHook: includeSqaa,
    installContextAugmentation: contextAugmentation !== null,
  } satisfies CodexIntegrationOptions;

  await installIntegration({
    registry: supportedIntegrations,
    integrationId: CODEX_INTEGRATION_ID,
    options: integrationOptions,
    targetRoot: installRoot,
    scope: installScope,
    auth,
    nonInteractive: options.nonInteractive,
    attrs: {
      ...buildAttrs({ projectKey: ctx.projectKey }),
      ...(contextAugmentation
        ? buildContextAugmentationAttrs(
            ctx.serverUrl,
            ctx.organization,
            contextAugmentation.scaEnabled,
          )
        : {}),
    },
  });
}

function buildAttrs(args: {
  projectKey: string | undefined;
}): Record<string, IntegrationStateAttribute> {
  return {
    projectKey: args.projectKey ?? null,
  };
}
