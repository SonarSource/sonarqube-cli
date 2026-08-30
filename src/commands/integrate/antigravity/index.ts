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

import type { CommandAuthenticatedInvocationContext } from '@/commands/command-invocation-context.ts';
import { installIntegration } from '@/core/framework/features';
import type { IntegrationStateAttribute } from '@/core/state/state.ts';
import { printAgentNonInteractiveAlternativeHint } from '@/core/ui/components/agent-prompt-hint.ts';

import { displayAgentIntegratePrelude } from '../_common/agent-integrate-prelude.ts';
import { buildRecordedIntegrationAttrs } from '../_common/context-augmentation.ts';
import { recordIntegrationConfigured } from '../_common/integrate-telemetry.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { resolveVortexSetup } from '../_common/vortex.ts';
import { supportedIntegrations } from '../index.ts';
import { ANTIGRAVITY_INTEGRATION_ID, type AntigravityIntegrationOptions } from './declaration.ts';
import { detectGlobalSecretsHook } from './hooks.ts';
import { resolveAntigravityInstallTarget } from './install-target.ts';

export async function integrateAntigravity(
  options: IntegrateAgentOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { auth } = ctx;
  if (!options.nonInteractive) {
    printAgentNonInteractiveAlternativeHint(
      'sonar integrate antigravity --non-interactive',
      'sonar integrate antigravity --non-interactive -g',
    );
  }

  const integrateCtx = await displayAgentIntegratePrelude(
    'Antigravity',
    'antigravity',
    options,
    auth,
  );

  const vortex = await resolveVortexSetup({
    auth,
    projectKey: integrateCtx.projectKey,
    isGlobal: integrateCtx.isGlobal,
  });

  const { installRoot: targetRoot, installScope: scope } = resolveAntigravityInstallTarget(
    integrateCtx.isGlobal,
    integrateCtx.project.projectRoot,
  );
  const existingGlobalHookPath = integrateCtx.isGlobal
    ? undefined
    : await detectGlobalSecretsHook();
  const globalSecretsHookExists = existingGlobalHookPath !== undefined;

  const integrationOptions: AntigravityIntegrationOptions = {
    ...options,
    projectRoot: integrateCtx.project.projectRoot,
    globalSecretsHookExists,
    vortexDisposition: vortex.disposition,
  };

  const attrs = buildRecordedIntegrationAttrs({
    baseAttrs: buildIntegrationAttrs(integrateCtx),
    projectRoot: integrateCtx.project.projectRoot,
    mainRepoRoot: integrateCtx.project.mainRepoRoot,
    serverUrl: integrateCtx.serverUrl,
    orgKey: integrateCtx.organization,
    contextAugmentation: vortex,
  });

  await installIntegration({
    registry: supportedIntegrations,
    integrationId: ANTIGRAVITY_INTEGRATION_ID,
    options: integrationOptions,
    targetRoot,
    scope,
    auth,
    nonInteractive: options.nonInteractive,
    attrs,
    onSuccess: (facts) => {
      recordIntegrationConfigured(ctx, {
        auth,
        integrationId: ANTIGRAVITY_INTEGRATION_ID,
        scope,
        nonInteractive: options.nonInteractive ?? false,
        isFromRouter: options.isFromRouter ?? false,
        ...facts,
      });
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
