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

// Shared postlude for agent integrate commands (the closing counterpart to
// agent-integrate-prelude): given an agent's resolved context and its
// agent-specific feature flags, resolve Vortex, assemble the integration
// options and recorded attrs, and run the install.

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { installIntegration } from '@/core/framework/features';

import { supportedIntegrations } from '../index.ts';
import {
  type AgentIntegrateContext,
  resolveIntegrateInstallTarget,
} from './agent-integrate-prelude.ts';
import { buildRecordedIntegrationAttrs } from './context-augmentation.ts';
import { recordIntegrationConfigured } from './integrate-telemetry.ts';
import type { IntegrateAgentOptions } from './types.ts';
import { resolveVortexSetup } from './vortex.ts';

export interface FinalizeAgentInstallParams<TOptions extends IntegrateAgentOptions> {
  integrationId: string;
  context: AgentIntegrateContext;
  options: IntegrateAgentOptions;
  auth: ResolvedAuth;
  ctx: CommandInvocationContext;
  /**
   * Agent-specific feature flags merged into the integration options (e.g. the
   * SQAA flag, whose name differs per agent). `projectRoot` and `vortexDisposition`
   * are derived here and must not be passed in.
   */
  featureOptions?: Partial<TOptions>;
}

/**
 * Shared install tail for agent integrations: resolves Vortex, assembles the
 * integration options and recorded state attrs, and runs `installIntegration`.
 * Keeps each agent handler focused on its agent-specific setup (prompts, scope
 * warnings).
 */
export async function finalizeAgentInstall<TOptions extends IntegrateAgentOptions>(
  params: FinalizeAgentInstallParams<TOptions>,
): Promise<void> {
  const { context, options, auth } = params;
  const vortex = await resolveVortexSetup({
    auth,
    projectKey: context.projectKey,
    isGlobal: context.isGlobal,
  });
  const { installRoot, installScope } = resolveIntegrateInstallTarget(
    context.isGlobal,
    context.project.projectRoot,
  );
  const attrs = buildRecordedIntegrationAttrs({
    baseAttrs: { projectKey: context.projectKey ?? null },
    projectRoot: context.project.projectRoot,
    mainRepoRoot: context.project.mainRepoRoot,
    serverUrl: context.serverUrl,
    orgKey: context.organization,
    contextAugmentation: vortex,
  });
  await installIntegration({
    registry: supportedIntegrations,
    integrationId: params.integrationId,
    options: {
      ...options,
      ...params.featureOptions,
      projectRoot: context.project.projectRoot,
      vortexDisposition: vortex.disposition,
    },
    targetRoot: installRoot,
    scope: installScope,
    auth,
    nonInteractive: options.nonInteractive,
    attrs,
    onSuccess: (facts) => {
      recordIntegrationConfigured(params.ctx, {
        auth,
        integrationId: params.integrationId,
        scope: installScope,
        nonInteractive: options.nonInteractive ?? false,
        isFromRouter: options.isFromRouter ?? false,
        ...facts,
      });
    },
  });
}
