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

import { homedir } from 'node:os';

import { isEnvBasedAuth, type ResolvedAuth } from '../../../../lib/auth-resolver';
import { discoverProject } from '../../../../lib/project-workspace';
import type { IntegrationScope, IntegrationStateAttribute } from '../../../../lib/state';
import { intro, warn } from '../../../../ui';
import { InvalidOptionError } from '../../_common/error';
import {
  buildContextAugmentationAttrs,
  resolveContextAugmentationSetup,
} from '../_common/context-augmentation';
import { installIntegration } from '../_common/registry';
import { resolveSqaaEntitlement } from '../_common/sqaa-entitlement';
import type { IntegrateAgentOptions } from '../_common/types';
import { COPILOT_INTEGRATION_ID, type CopilotIntegrationOptions } from './declaration';
import { detectGlobalSecretsHook } from './hooks';

export async function integrateCopilot(auth: ResolvedAuth, options: IntegrateAgentOptions) {
  if (options.global && options.project) {
    throw new InvalidOptionError(
      '--global and --project are mutually exclusive; please specify only one scope.',
    );
  }

  intro('SonarQube integration for Copilot');

  const project = await discoverProject(process.cwd());
  const isGlobal = options.global ?? false;
  const projectKey = options.project || project.projectKey;
  if (!isGlobal && !projectKey) {
    warn(
      'No project key provided - project related actions will be skipped. Run `sonar integrate copilot --help` for ways to define a project.',
    );
  }

  const entitled = await resolveSqaaEntitlement(auth.serverUrl, auth.token, auth.orgKey);
  const sqaaProjectKey = entitled && projectKey ? projectKey : undefined;

  const targetRoot = isGlobal ? homedir() : project.rootDir;
  const scope: IntegrationScope = isGlobal ? 'global' : 'project';
  const existingGlobalHookPath = isGlobal ? undefined : await detectGlobalSecretsHook();
  const installHook = existingGlobalHookPath === undefined;

  const contextAugmentation = options.skipContext
    ? null
    : await resolveContextAugmentationSetup({
        auth,
        projectKey,
        isGlobal,
      });
  const integrationOptions: CopilotIntegrationOptions = {
    ...options,
    projectRoot: project.rootDir,
    installHook,
    installSqaaInstructions: sqaaProjectKey !== undefined,
    sqaaEntitled: entitled,
    installContextAugmentation: contextAugmentation !== null,
  };

  await installIntegration({
    integrationId: COPILOT_INTEGRATION_ID,
    options: integrationOptions,
    targetRoot,
    scope,
    auth,
    nonInteractive: !!options.nonInteractive || isEnvBasedAuth(),
    attrs: {
      ...buildIntegrationAttrs(projectKey),
      ...(contextAugmentation
        ? buildContextAugmentationAttrs(auth.serverUrl, auth.orgKey, contextAugmentation.scaEnabled)
        : {}),
    },
  });
}

function buildIntegrationAttrs(
  projectKey: string | undefined,
): Record<string, IntegrationStateAttribute> {
  return {
    projectKey: projectKey ?? null,
  };
}
