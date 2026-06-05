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
import { COPILOT_INTEGRATION_ID, type CopilotIntegrationOptions } from './declaration';
import { detectGlobalSecretsHook } from './hooks';

export async function integrateCopilot(auth: ResolvedAuth, options: IntegrateAgentOptions) {
  const ctx = await displayAgentIntegratePrelude('Copilot', 'copilot', options, auth);

  // SQAA is always project-scoped. resolveSqaaSetup returns false (and surfaces
  // the consistent "not supported with --global" notice when the org is
  // entitled) on a global install; on a project install it returns the raw
  // entitlement, which drives the declarative skip messaging (missing-key vs
  // promotion).
  const entitled = await resolveSqaaSetup({
    serverURL: ctx.serverUrl,
    token: ctx.token,
    organization: ctx.organization,
    isGlobal: ctx.isGlobal,
  });
  const sqaaProjectKey = entitled && ctx.projectKey ? ctx.projectKey : undefined;

  const { installRoot: targetRoot, installScope: scope } = resolveIntegrateInstallTarget(
    ctx.isGlobal,
    ctx.project.rootDir,
  );
  const existingGlobalHookPath = ctx.isGlobal ? undefined : await detectGlobalSecretsHook();
  const globalSecretsHookExists = existingGlobalHookPath !== undefined;

  const contextAugmentation = options.skipContext
    ? null
    : await resolveContextAugmentationSetup({
        auth,
        projectKey: ctx.projectKey,
        isGlobal: ctx.isGlobal,
      });
  const integrationOptions: CopilotIntegrationOptions = {
    ...options,
    projectRoot: ctx.project.rootDir,
    globalSecretsHookExists,
    installSqaaInstructions: sqaaProjectKey !== undefined,
    sqaaEntitled: entitled,
    installContextAugmentation: contextAugmentation !== null,
  };

  await installIntegration({
    registry: supportedIntegrations,
    integrationId: COPILOT_INTEGRATION_ID,
    options: integrationOptions,
    targetRoot,
    scope,
    auth,
    nonInteractive: options.nonInteractive,
    attrs: {
      ...buildIntegrationAttrs(ctx.projectKey),
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

function buildIntegrationAttrs(
  projectKey: string | undefined,
): Record<string, IntegrationStateAttribute> {
  return {
    projectKey: projectKey ?? null,
  };
}
