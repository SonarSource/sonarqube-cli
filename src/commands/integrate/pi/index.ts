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
import { printAgentNonInteractiveAlternativeHint } from '@/core/ui/components/agent-prompt-hint.ts';

import { finalizeAgentInstall } from '../_common/agent-integrate-postlude.ts';
import { displayAgentIntegratePrelude } from '../_common/agent-integrate-prelude.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { PI_INTEGRATION_ID } from './declaration.ts';

export async function integratePi(
  options: IntegrateAgentOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { auth, console } = ctx;
  if (!options.nonInteractive) {
    printAgentNonInteractiveAlternativeHint(console, 'sonar integrate pi --non-interactive');
  }

  const integrateCtx = await displayAgentIntegratePrelude('Pi', auth, console);

  await finalizeAgentInstall<IntegrateAgentOptions>({
    integrationId: PI_INTEGRATION_ID,
    context: integrateCtx,
    options,
    auth,
    ctx,
  });
}
