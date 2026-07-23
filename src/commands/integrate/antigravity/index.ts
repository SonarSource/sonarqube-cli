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

import type { ResolvedAuth } from '@/core/host/auth-resolver.ts';
import { info } from '@/core/ui';

import type { IntegrationStateAttribute } from '../../../lib/state.ts';
import { printAgentNonInteractiveAlternativeHint } from '../../_common/agent-prompt-hint.ts';
import { displayAgentIntegratePrelude } from '../_common/agent-integrate-prelude.ts';
import {
  buildRecordedIntegrationAttrs,
  resolveContextAugmentationSetup,
} from '../_common/context-augmentation.ts';
import { installIntegration } from '../_common/registry';
import { resolveSqaaSetup } from '../_common/sqaa-entitlement.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { supportedIntegrations } from '../index.ts';
import { ANTIGRAVITY_INTEGRATION_ID, type AntigravityIntegrationOptions } from './declaration.ts';
import { detectGlobalSecretsHook } from './hooks.ts';
import { resolveAntigravityInstallTarget } from './install-target.ts';

export async function integrateAntigravity(
  options: IntegrateAgentOptions,
  auth: ResolvedAuth,
): Promise<void> {
  if (!options.nonInteractive) {
    printAgentNonInteractiveAlternativeHint(
      'sonar integrate antigravity --non-interactive',
      'sonar integrate antigravity --non-interactive -g',
    );
  }

  const ctx = await displayAgentIntegratePrelude('Antigravity', 'antigravity', options, auth);

  if (options.skipContext) {
    info('Skipping Vortex context augmentation (--skip-context).');
  }

  const sqaaEligible = await resolveSqaaSetup({
    serverURL: ctx.serverUrl,
    token: ctx.token,
    organization: ctx.organization,
    isGlobal: ctx.isGlobal,
  });
  const includeSqaa = sqaaEligible && Boolean(ctx.projectKey);

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
    installSqaaInstructions: includeSqaa,
    installContextAugmentation: contextAugmentation !== null,
  };

  const attrs = await buildRecordedIntegrationAttrs({
    baseAttrs: buildIntegrationAttrs(ctx),
    projectRoot: ctx.project.rootDir,
    serverUrl: ctx.serverUrl,
    orgKey: ctx.organization,
    contextAugmentation,
  });

  await installIntegration({
    registry: supportedIntegrations,
    integrationId: ANTIGRAVITY_INTEGRATION_ID,
    options: integrationOptions,
    targetRoot,
    scope,
    auth,
    nonInteractive: options.nonInteractive,
    isFromRouter: options.isFromRouter,
    attrs,
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
