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

import type { CliAuthenticatedContext } from '@/commands/cli-context.ts';
import { printAgentNonInteractiveAlternativeHint } from '@/core/ui/components/agent-prompt-hint.ts';

import { finalizeAgentInstall } from '../_common/agent-integrate-postlude.ts';
import { displayAgentIntegratePrelude } from '../_common/agent-integrate-prelude.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { COPILOT_INTEGRATION_ID, type CopilotIntegrationOptions } from './declaration.ts';
import { detectGlobalSecretsHook } from './hooks.ts';

export async function integrateCopilot(
  options: IntegrateAgentOptions,
  ctx: CliAuthenticatedContext,
) {
  const { auth } = ctx;
  if (!options.nonInteractive) {
    printAgentNonInteractiveAlternativeHint(
      'sonar integrate copilot --non-interactive',
      'sonar integrate copilot --non-interactive -g',
    );
  }

  const integrateCtx = await displayAgentIntegratePrelude('Copilot', 'copilot', options, auth);

  const existingGlobalHookPath = integrateCtx.isGlobal
    ? undefined
    : await detectGlobalSecretsHook();

  await finalizeAgentInstall<CopilotIntegrationOptions>({
    integrationId: COPILOT_INTEGRATION_ID,
    context: integrateCtx,
    options,
    auth,
    featureOptions: {
      globalSecretsHookExists: existingGlobalHookPath !== undefined,
    },
  });
}
