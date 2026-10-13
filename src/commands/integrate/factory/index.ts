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

import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { installIntegration } from '@/core/framework/features';
import { printAgentNonInteractiveAlternativeHint } from '@/core/ui/components/agent-prompt-hint.ts';

import {
  displayAgentIntegratePrelude,
  resolveIntegrateInstallTarget,
} from '../_common/agent-integrate-prelude.ts';
import { recordIntegrationConfigured } from '../_common/integrate-telemetry.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { supportedIntegrations } from '../index.ts';
import { FACTORY_INTEGRATION_ID, type FactoryIntegrationOptions } from './declaration.ts';

export async function integrateFactory(
  options: IntegrateAgentOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { auth, console } = ctx;
  if (!options.nonInteractive) {
    printAgentNonInteractiveAlternativeHint(console, 'sonar integrate factory --non-interactive');
  }

  await displayAgentIntegratePrelude('Factory', auth, console);
  const { installRoot, installScope } = resolveIntegrateInstallTarget();

  await installIntegration<FactoryIntegrationOptions>({
    registry: supportedIntegrations,
    integrationId: FACTORY_INTEGRATION_ID,
    options,
    targetRoot: installRoot,
    scope: installScope,
    console,
    auth,
    nonInteractive: options.nonInteractive,
    onSuccess: (facts) => {
      recordIntegrationConfigured(ctx, {
        auth,
        integrationId: FACTORY_INTEGRATION_ID,
        scope: installScope,
        nonInteractive: options.nonInteractive ?? false,
        isFromRouter: options.isFromRouter ?? false,
        ...facts,
      });
    },
  });
}
