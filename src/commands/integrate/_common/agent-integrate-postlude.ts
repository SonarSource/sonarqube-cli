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
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { installIntegration } from '@/core/framework/features';
import { loadState, updateState } from '@/core/state/state-repository.ts';

import { supportedIntegrations } from '../index.ts';
import { withAgentInstallLock } from './agent-install-lock.ts';
import { resolveIntegrateInstallTarget } from './agent-integrate-prelude.ts';
import { buildRecordedIntegrationAttrs } from './context-augmentation.ts';
import { recordIntegrationConfigured } from './integrate-telemetry.ts';
import { warnIfMcpRuntimeUnavailable } from './mcp-runtime-warning.ts';
import type { IntegrateAgentOptions } from './types.ts';
import { resolveVortexSetup } from './vortex.ts';

export interface FinalizeAgentInstallParams<TOptions extends IntegrateAgentOptions> {
  integrationId: string;
  options: IntegrateAgentOptions;
  auth: ResolvedAuth;
  ctx: CommandInvocationContext;
  /**
   * Agent-specific feature flags merged into the integration options (e.g. the
   * SQAA flag, whose name differs per agent). `vortexDisposition` is derived
   * here and must not be passed in.
   */
  featureOptions?: Partial<TOptions>;
  installTarget?: ReturnType<typeof resolveIntegrateInstallTarget>;
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
  if (params.options.fromBulkSetup) {
    return installAgent(params);
  }
  return withAgentInstallLock(() => installAgent(params));
}

async function installAgent<TOptions extends IntegrateAgentOptions>(
  params: FinalizeAgentInstallParams<TOptions>,
): Promise<void> {
  const { options, auth } = params;
  const vortex = await resolveVortexSetup(auth, params.ctx.console);
  if (options.fromBulkSetup && vortex.disposition.action === 'preserve') {
    throw new CommandFailedError(
      'Could not check Vortex entitlement. Retry setup once the connection is available.',
    );
  }
  const { installRoot, installScope } = params.installTarget ?? resolveIntegrateInstallTarget();
  const attrs = buildRecordedIntegrationAttrs({
    serverUrl: auth.serverUrl,
    orgKey: auth.orgKey,
    contextAugmentation: vortex,
  });
  const completion = { saved: false };
  await installIntegration({
    registry: supportedIntegrations,
    integrationId: params.integrationId,
    options: {
      ...options,
      ...params.featureOptions,
      vortexDisposition: vortex.disposition,
    },
    targetRoot: installRoot,
    scope: installScope,
    console: params.ctx.console,
    auth,
    nonInteractive: options.nonInteractive,
    attrs,
    onSuccess: (facts) => {
      completion.saved = true;
      if (loadState().integrations.onboarding?.[params.integrationId]) {
        updateState((state) => {
          const onboarding = state.integrations.onboarding;
          const pending = onboarding?.[params.integrationId];
          if (!onboarding || !pending || pending.status === 'skipped') return;
          state.integrations.onboarding = Object.fromEntries(
            Object.entries(onboarding).filter(([id]) => id !== params.integrationId),
          );
        });
      }
      recordIntegrationConfigured(params.ctx, {
        auth,
        integrationId: params.integrationId,
        scope: installScope,
        nonInteractive: options.nonInteractive ?? false,
        isFromRouter: options.isFromRouter ?? false,
        setupSource: options.setupSource,
        ...facts,
      });
    },
  });
  if (options.fromBulkSetup && !completion.saved) {
    throw new CommandFailedError('Could not save completed agent setup.');
  }
  await warnIfMcpRuntimeUnavailable(params.ctx.console, params.integrationId, installRoot);
}
