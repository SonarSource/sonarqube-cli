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

// Shared closing step for agent integrate commands (the counterpart to
// agent-integrate-prelude): given an agent's resolved context and its
// agent-specific feature flags, resolve Context Augmentation, assemble the
// integration options and recorded attrs, and run the install.

import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import type { IntegrationStateAttribute } from '../../../../lib/state';
import { supportedIntegrations } from '../index.js';
import {
  type AgentIntegrateContext,
  resolveIntegrateInstallTarget,
} from './agent-integrate-prelude';
import {
  buildContextAugmentationAttrs,
  resolveContextAugmentationSetup,
} from './context-augmentation';
import { installIntegration } from './registry';
import type { IntegrateAgentOptions } from './types';

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
  const attrs: Record<string, IntegrationStateAttribute> = {
    projectKey: context.projectKey ?? null,
    ...(contextAugmentation
      ? buildContextAugmentationAttrs(
          context.serverUrl,
          context.organization,
          contextAugmentation.scaEnabled,
        )
      : {}),
  };
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
    attrs,
  });
}
