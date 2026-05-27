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
import { join } from 'node:path';

import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import { discoverProject } from '../../../../lib/project-workspace';
import type { IntegrationScope } from '../../../../lib/state';
import { intro, success, warn } from '../../../../ui';
import { InvalidOptionError } from '../../_common/error';
import { setupContextAugmentation } from '../_common/context-augmentation';
import { installIntegration } from '../_common/registry';
import { resolveSqaaEntitlement, warnSqaaSkippedOnGlobal } from '../_common/sqaa-entitlement';
import type { IntegrateAgentOptions } from '../_common/types';
import { COPILOT_INTEGRATION_ID, type CopilotIntegrationOptions } from './declaration';
import {
  detectGlobalSecretsHook,
  hookScriptName,
  PROJECT_HOOKS_REL_DIR,
  SCRIPT_REL_DIR,
} from './hooks';
import {
  INSTRUCTIONS_FILENAME,
  PROJECT_INSTRUCTIONS_REL_DIR,
  warnIfProjectInstructionsShadowGlobal,
} from './instructions';

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

  const sqaaEntitled = await resolveSqaaEntitlement(auth.serverUrl, auth.token, auth.orgKey);
  // SQAA is project-scoped; never install it during a global install. We still
  // surface the entitlement check so we can hint the user to re-run per-project.
  const installSqaa = !isGlobal && sqaaEntitled && projectKey !== undefined;

  const targetRoot = isGlobal ? homedir() : project.rootDir;
  const scope: IntegrationScope = isGlobal ? 'global' : 'project';
  const existingGlobalHookPath = isGlobal ? undefined : await detectGlobalSecretsHook();
  const installHook = existingGlobalHookPath === undefined;
  if (!isGlobal) {
    warnIfProjectInstructionsShadowGlobal();
  }

  const integrationOptions: CopilotIntegrationOptions = {
    ...options,
    projectRoot: project.rootDir,
    installHook,
    installPromptSecretsInstructions: true,
    installSqaaInstructions: installSqaa,
    installMcp: true,
  };

  await installIntegration({
    integrationId: COPILOT_INTEGRATION_ID,
    options: integrationOptions,
    targetRoot,
    scope,
    attrs: { projectKey: projectKey ?? null },
  });

  if (!options.skipContext) {
    await setupContextAugmentation({
      auth,
      agent: 'copilot',
      projectRoot: project.rootDir,
      projectKey,
      isGlobal,
    });
  }

  reportInstallationOutcome({
    isGlobal,
    hookPath: existingGlobalHookPath ?? expectedHookPath(targetRoot, scope),
    instructionsPath: expectedInstructionsPath(targetRoot, scope),
    sqaaInstalled: installSqaa,
  });
  warnSqaaSkippedOnGlobal(isGlobal, sqaaEntitled);
}

interface InstallationOutcome {
  isGlobal: boolean;
  hookPath: string;
  instructionsPath: string;
  sqaaInstalled: boolean;
}

function reportInstallationOutcome(outcome: InstallationOutcome): void {
  const scope = outcome.isGlobal
    ? 'Copilot integration successfully configured globally'
    : 'Copilot integration successfully configured at the project level';
  const instructionsLines = formatInstructionsLines(outcome);
  const hookLine = `Hook: ${outcome.hookPath}`;
  success([scope, hookLine, ...instructionsLines].join('\n'));
}

function formatInstructionsLines({
  instructionsPath,
  sqaaInstalled,
}: InstallationOutcome): string[] {
  if (sqaaInstalled) {
    return [
      `Instructions (secrets scanning for prompts, SonarQube Agentic Analysis): ${instructionsPath}`,
    ];
  }
  return [`Instructions (secrets scanning for prompts): ${instructionsPath}`];
}

function expectedHookPath(targetRoot: string, scope: IntegrationScope): string {
  return scope === 'global'
    ? join(targetRoot, '.copilot', 'hooks', SCRIPT_REL_DIR, hookScriptName())
    : join(targetRoot, PROJECT_HOOKS_REL_DIR, SCRIPT_REL_DIR, hookScriptName());
}

function expectedInstructionsPath(targetRoot: string, scope: IntegrationScope): string {
  return scope === 'global'
    ? join(targetRoot, '.copilot', 'instructions', INSTRUCTIONS_FILENAME)
    : join(targetRoot, PROJECT_INSTRUCTIONS_REL_DIR, INSTRUCTIONS_FILENAME);
}
