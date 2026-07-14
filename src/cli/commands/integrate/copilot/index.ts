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

import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import { printAgentNonInteractiveAlternativeHint } from '../../_common/agent-prompt-hint';
import { finalizeAgentInstall } from '../_common/agent-integrate-postlude';
import { displayAgentIntegratePrelude } from '../_common/agent-integrate-prelude';
import { resolveSqaaSetup } from '../_common/sqaa-entitlement';
import type { IntegrateAgentOptions } from '../_common/types';
import { COPILOT_INTEGRATION_ID, type CopilotIntegrationOptions } from './declaration';
import { detectGlobalSecretsHook } from './hooks';

export async function integrateCopilot(options: IntegrateAgentOptions, auth: ResolvedAuth) {
  if (!options.nonInteractive) {
    printAgentNonInteractiveAlternativeHint(
      'sonar integrate copilot -p <project-key>',
      'sonar integrate copilot -g',
    );
  }

  const ctx = await displayAgentIntegratePrelude('Copilot', 'copilot', options, auth);

  // SQAA is always project-scoped. resolveSqaaSetup owns the user-facing
  // messaging: it surfaces the promotion message when the org is not entitled
  // and the "not supported with --global" notice on an entitled global install.
  const entitled = await resolveSqaaSetup({
    serverURL: ctx.serverUrl,
    token: ctx.token,
    organization: ctx.organization,
    isGlobal: ctx.isGlobal,
  });
  const existingGlobalHookPath = ctx.isGlobal ? undefined : await detectGlobalSecretsHook();

  await finalizeAgentInstall<CopilotIntegrationOptions>({
    integrationId: COPILOT_INTEGRATION_ID,
    context: ctx,
    options,
    auth,
    featureOptions: {
      projectRoot: ctx.project.rootDir,
      globalSecretsHookExists: existingGlobalHookPath !== undefined,
      installSqaaInstructions: entitled && Boolean(ctx.projectKey),
    },
  });
}
