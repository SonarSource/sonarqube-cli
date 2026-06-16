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
import { info } from '../../../../ui';
import { displayAgentIntegratePrelude } from '../_common/agent-integrate-prelude';
import {
  buildContextAugmentationAttrs,
  resolveContextAugmentationSetup,
} from '../_common/context-augmentation';
import { createIntegrationRegistry, installIntegration } from '../_common/registry';
import type { IntegrateAgentOptions } from '../_common/types';
import {
  ANTIGRAVITY_INTEGRATION_ID,
  antigravityIntegration,
  type AntigravityIntegrationOptions,
} from './declaration';
import { detectGlobalSecretsHook } from './hooks';
import { resolveAntigravityInstallTarget } from './install-target';

const antigravityIntegrations = createIntegrationRegistry([antigravityIntegration]);

export async function integrateAntigravity(
  options: IntegrateAgentOptions,
  auth: ResolvedAuth,
): Promise<void> {
  const ctx = await displayAgentIntegratePrelude('Antigravity', 'antigravity', options, auth);

  if (options.skipContext) {
    info('Skipping Context Augmentation (--skip-context).');
  }
  const contextAugmentation = options.skipContext
    ? null
    : await resolveContextAugmentationSetup({
        auth,
        projectKey: ctx.projectKey,
        isGlobal: ctx.isGlobal,
      });

  const { installRoot: targetRoot, installScope: scope } = resolveAntigravityInstallTarget(
    ctx.isGlobal,
    ctx.project.rootDir,
  );
  const existingGlobalHookPath = ctx.isGlobal ? undefined : await detectGlobalSecretsHook();
  const globalSecretsHookExists = existingGlobalHookPath !== undefined;

  const integrationOptions: AntigravityIntegrationOptions = {
    ...options,
    projectRoot: ctx.project.rootDir,
    globalSecretsHookExists,
    installContextAugmentation: contextAugmentation !== null,
  };

  await installIntegration({
    registry: antigravityIntegrations,
    integrationId: ANTIGRAVITY_INTEGRATION_ID,
    options: integrationOptions,
    targetRoot,
    scope,
    auth,
    nonInteractive: options.nonInteractive,
    attrs: {
      ...buildIntegrationAttrs(ctx),
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

function buildIntegrationAttrs(ctx: {
  serverUrl: string;
  organization: string | undefined;
  projectKey: string | undefined;
}): Record<string, IntegrationStateAttribute> {
  return {
    projectKey: ctx.projectKey ?? null,
    serverUrl: ctx.serverUrl,
    orgKey: ctx.organization ?? null,
  };
}
