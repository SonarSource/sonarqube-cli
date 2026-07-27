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
// agent-specific feature flags, resolve Context Augmentation, assemble the
// integration options and recorded attrs, and run the install.

import { installIntegration } from '@/core/framework/features';
import type { ResolvedAuth } from '@/core/host/auth-resolver.ts';

import { supportedIntegrations } from '../index.ts';
import {
  type AgentIntegrateContext,
  resolveIntegrateInstallTarget,
} from './agent-integrate-prelude.ts';
import {
  buildRecordedIntegrationAttrs,
  resolveContextAugmentationSetup,
} from './context-augmentation.ts';
import type { IntegrateAgentOptions } from './types.ts';

export interface FinalizeAgentInstallParams<TOptions extends IntegrateAgentOptions> {
  integrationId: string;
  context: AgentIntegrateContext;
  options: IntegrateAgentOptions;
  auth: ResolvedAuth;
  /**
   * Agent-specific feature flags merged into the integration options (e.g. the
   * SQAA flag, whose name differs per agent). `installContextAugmentation` is
   * derived here and must not be passed in.
   */
  featureOptions?: Partial<TOptions>;
}

/**
 * Shared install tail for agent integrations: resolves Context Augmentation
 * (honouring `--skip-context`), assembles the integration options and recorded
 * state attrs, and runs `installIntegration`. Keeps each agent handler focused
 * on its agent-specific setup (prompts, scope warnings, SQAA option name).
 */
export async function finalizeAgentInstall<TOptions extends IntegrateAgentOptions>(
  params: FinalizeAgentInstallParams<TOptions>,
): Promise<void> {
  const { context, options, auth } = params;
  const contextAugmentation = options.skipContext
    ? null
    : await resolveContextAugmentationSetup({
        auth,
        projectKey: context.projectKey,
        isGlobal: context.isGlobal,
      });
  const { installRoot, installScope } = resolveIntegrateInstallTarget(
    context.isGlobal,
    context.project.rootDir,
  );
  const attrs = await buildRecordedIntegrationAttrs({
    baseAttrs: { projectKey: context.projectKey ?? null },
    projectRoot: context.project.rootDir,
    serverUrl: context.serverUrl,
    orgKey: context.organization,
    contextAugmentation,
  });
  await installIntegration({
    registry: supportedIntegrations,
    integrationId: params.integrationId,
    options: {
      ...options,
      ...params.featureOptions,
      installContextAugmentation: contextAugmentation !== null,
    },
    targetRoot: installRoot,
    scope: installScope,
    auth,
    nonInteractive: options.nonInteractive,
    isFromRouter: options.isFromRouter,
    attrs,
  });
}
