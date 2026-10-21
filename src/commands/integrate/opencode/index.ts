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

// Integrate command — setup SonarQube integration for OpenCode.

import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { yellow } from '@/core/ui/colors.ts';
import { printAgentNonInteractiveAlternativeHint } from '@/core/ui/components/agent-prompt-hint.ts';

import { finalizeAgentInstall } from '../_common/agent-integrate-postlude.ts';
import { displayAgentIntegratePrelude } from '../_common/agent-integrate-prelude.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { OPENCODE_INTEGRATION_ID, type OpenCodeIntegrationOptions } from './declaration.ts';
import { detectLegacyOpenCodeVersion } from './version.ts';

const WARNING_PREFIX = '  ⚠️  ';
const ARROW_PREFIX = '     → ';

function legacyDetectedMessage(version: string): string {
  return [
    `${WARNING_PREFIX}OpenCode ${version} detected. These plugins require OpenCode 2.0 or later.`,
    `${ARROW_PREFIX}Upgrade OpenCode to 2.0 or later.`,
  ].join('\n');
}

const LEGACY_SETUP_COMPLETE_MESSAGE = [
  `${WARNING_PREFIX}Setup complete, but plugins are inactive until you upgrade to OpenCode 2.0.`,
  `${ARROW_PREFIX}Upgrade OpenCode to activate them.`,
].join('\n');

export async function integrateOpenCode(
  options: IntegrateAgentOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { auth, console } = ctx;
  if (!options.nonInteractive) {
    printAgentNonInteractiveAlternativeHint(console, 'sonar integrate opencode --non-interactive');
  }

  await displayAgentIntegratePrelude('OpenCode', auth, console);
  const legacyVersion = await detectLegacyOpenCodeVersion();
  if (legacyVersion) {
    console.text(legacyDetectedMessage(legacyVersion), yellow, 'stderr');
    console.blank();
  }

  await finalizeAgentInstall<OpenCodeIntegrationOptions>({
    integrationId: OPENCODE_INTEGRATION_ID,
    options,
    auth,
    ctx,
  });
  if (legacyVersion) {
    console.blank();
    console.text(LEGACY_SETUP_COMPLETE_MESSAGE, yellow, 'stderr');
  }
}
