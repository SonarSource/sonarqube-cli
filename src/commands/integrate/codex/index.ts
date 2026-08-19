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

// Integrate command — setup SonarQube integration for Codex.

import type { CliAuthenticatedContext } from '@/commands/cli-authenticated-context.ts';
import { printAgentNonInteractiveAlternativeHint } from '@/core/ui/components/agent-prompt-hint.ts';

import { finalizeAgentInstall } from '../_common/agent-integrate-postlude.ts';
import { displayAgentIntegratePrelude } from '../_common/agent-integrate-prelude.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { CODEX_INTEGRATION_ID, type CodexIntegrationOptions } from './declaration.ts';

export async function integrateCodex(
  options: IntegrateAgentOptions,
  ctx: CliAuthenticatedContext,
): Promise<void> {
  const { auth } = ctx;
  if (!options.nonInteractive) {
    printAgentNonInteractiveAlternativeHint(
      'sonar integrate codex --non-interactive',
      'sonar integrate codex --non-interactive -g',
    );
  }

  const integrateCtx = await displayAgentIntegratePrelude('Codex', 'codex', options, auth);

  await finalizeAgentInstall<CodexIntegrationOptions>({
    integrationId: CODEX_INTEGRATION_ID,
    context: integrateCtx,
    options,
    auth,
  });
}
