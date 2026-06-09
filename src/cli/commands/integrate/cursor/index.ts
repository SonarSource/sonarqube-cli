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

// Integrate command — setup SonarQube integration for Cursor.

import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import type { IntegrationStateAttribute } from '../../../../lib/state';
import { warn } from '../../../../ui';
import {
  displayAgentIntegratePrelude,
  resolveIntegrateInstallTarget,
} from '../_common/agent-integrate-prelude';
import { installIntegration } from '../_common/registry';
import type { IntegrateAgentOptions } from '../_common/types';
import { supportedIntegrations } from '../index.js';
import { CURSOR_INTEGRATION_ID } from './declaration';

export async function integrateCursor(
  options: IntegrateAgentOptions,
  auth: ResolvedAuth,
): Promise<void> {
  const ctx = await displayAgentIntegratePrelude('Cursor', 'cursor', options, auth);

  if (ctx.isGlobal) {
    warn(
      "Cursor's cloud/background agents only pick up project-level hooks, not global ones. Re-run without --global from a project directory for full hook coverage.",
    );
  }

  const { installRoot, installScope } = resolveIntegrateInstallTarget(
    ctx.isGlobal,
    ctx.project.rootDir,
  );

  await installIntegration({
    registry: supportedIntegrations,
    integrationId: CURSOR_INTEGRATION_ID,
    options,
    targetRoot: installRoot,
    scope: installScope,
    auth,
    nonInteractive: options.nonInteractive,
    attrs: buildAttrs({ projectKey: ctx.projectKey }),
  });
}

function buildAttrs(args: {
  projectKey: string | undefined;
}): Record<string, IntegrationStateAttribute> {
  return {
    projectKey: args.projectKey ?? null,
  };
}
