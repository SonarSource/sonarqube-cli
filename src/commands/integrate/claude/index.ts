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

// Integrate command - setup SonarQube integration for Claude Code

import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { installIntegration } from '@/core/framework/features';
import { printAgentNonInteractiveAlternativeHint } from '@/core/ui/components/agent-prompt-hint.ts';

import {
  displayAgentIntegratePrelude,
  resolveIntegrateInstallTarget,
} from '../_common/agent-integrate-prelude.ts';
import { buildRecordedIntegrationAttrs } from '../_common/context-augmentation.ts';
import { recordIntegrationConfigured } from '../_common/integrate-telemetry.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { resolveVortexSetup } from '../_common/vortex.ts';
import { supportedIntegrations } from '../index.ts';
import { CLAUDE_INTEGRATION_ID, type ClaudeIntegrationOptions } from './declaration.ts';

/**
 * Integrate command handler
 */
export async function integrateClaude(
  options: IntegrateAgentOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { auth, console } = ctx;
  if (!options.nonInteractive) {
    printAgentNonInteractiveAlternativeHint(console, 'sonar integrate claude --non-interactive');
  }

  await displayAgentIntegratePrelude('Claude Code', auth, console);

  const vortex = await resolveVortexSetup(auth, console);
  const featureAttrs = buildRecordedIntegrationAttrs({
    serverUrl: auth.serverUrl,
    orgKey: auth.orgKey,
    contextAugmentation: vortex,
  });
  const { installRoot, installScope } = resolveIntegrateInstallTarget();
  const integrationOptions = {
    ...options,
    vortexDisposition: vortex.disposition,
  } satisfies ClaudeIntegrationOptions;
  await installIntegration({
    registry: supportedIntegrations,
    integrationId: CLAUDE_INTEGRATION_ID,
    options: integrationOptions,
    targetRoot: installRoot,
    scope: installScope,
    console: ctx.console,
    auth,
    attrs: featureAttrs,
    nonInteractive: options.nonInteractive,
    onSuccess: (facts) => {
      recordIntegrationConfigured(ctx, {
        auth,
        integrationId: CLAUDE_INTEGRATION_ID,
        scope: installScope,
        nonInteractive: options.nonInteractive ?? false,
        isFromRouter: options.isFromRouter ?? false,
        ...facts,
      });
    },
  });
}
