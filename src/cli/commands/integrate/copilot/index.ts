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
import type { IntegrationScope, IntegrationStateAttribute } from '../../../../lib/state';
import { intro, success, warn } from '../../../../ui';
import { InvalidOptionError } from '../../_common/error';
import { setupContextAugmentation } from '../_common/context-augmentation';
import { installIntegration } from '../_common/registry';
import { resolveSqaaEntitlement } from '../_common/sqaa-entitlement';
import type { IntegrateAgentOptions } from '../_common/types';
import {
  COPILOT_INTEGRATION_ID,
  type CopilotIntegrationOptions,
  registerCopilotIntegration,
} from './declaration';
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
import { updateCopilotState } from './state';

registerCopilotIntegration();

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
  if (!isGlobal) {
    warnIfProjectInstructionsShadowGlobal();
  }

  const integrationOptions: CopilotIntegrationOptions = {
    ...options,
    projectRoot: project.rootDir,
    installBinary: true,
    installHook,
    installInstructions: true,
    installSqaaInstructions: sqaaProjectKey !== undefined,
    installMcp: true,
  };

  await installIntegration({
    integrationId: COPILOT_INTEGRATION_ID,
    options: integrationOptions,
    targetRoot,
    scope,
    attrs: buildIntegrationAttrs(projectKey, sqaaProjectKey !== undefined),
  });

  await updateCopilotState(project.rootDir, isGlobal, {
    hookInstalled: installHook,
    promptSecretsInstructionsInstalled: true,
    sqaaInstructionsInstalled: sqaaProjectKey !== undefined,
    projectKey: sqaaProjectKey,
    orgKey: sqaaProjectKey ? auth.orgKey : undefined,
    serverUrl: sqaaProjectKey ? auth.serverUrl : undefined,
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
    promptInstructionsPath: expectedPromptInstructionsPath(targetRoot, scope),
    sqaaInstructionsPath:
      sqaaProjectKey === undefined ? undefined : expectedSqaaInstructionsPath(project.rootDir),
  });
}

interface InstallationOutcome {
  isGlobal: boolean;
  hookPath: string;
  promptInstructionsPath: string;
  sqaaInstructionsPath?: string;
}

function reportInstallationOutcome({
  isGlobal,
  hookPath,
  promptInstructionsPath,
  sqaaInstructionsPath,
}: InstallationOutcome): void {
  const scope = isGlobal
    ? 'Copilot integration successfully configured globally'
    : 'Copilot integration successfully configured at the project level';
  const instructionsLines = formatInstructionsLines(promptInstructionsPath, sqaaInstructionsPath);
  const hookLine = `Hook: ${hookPath}`;
  success([scope, hookLine, ...instructionsLines].join('\n'));
}

function formatInstructionsLines(
  promptInstructionsPath: string,
  sqaaInstructionsPath?: string,
): string[] {
  if (sqaaInstructionsPath && sqaaInstructionsPath === promptInstructionsPath) {
    return [
      `Instructions (secrets scanning for prompts, SonarQube Agentic Analysis): ${promptInstructionsPath}`,
    ];
  }

  const lines = [`Instructions (secrets scanning for prompts): ${promptInstructionsPath}`];
  if (sqaaInstructionsPath) {
    lines.push(`Instructions (SonarQube Agentic Analysis): ${sqaaInstructionsPath}`);
  }
  return lines;
}

function expectedHookPath(targetRoot: string, scope: IntegrationScope): string {
  return scope === 'global'
    ? join(targetRoot, '.copilot', 'hooks', SCRIPT_REL_DIR, hookScriptName())
    : join(targetRoot, PROJECT_HOOKS_REL_DIR, SCRIPT_REL_DIR, hookScriptName());
}

function expectedPromptInstructionsPath(targetRoot: string, scope: IntegrationScope): string {
  return scope === 'global'
    ? join(targetRoot, '.copilot', 'instructions', INSTRUCTIONS_FILENAME)
    : expectedSqaaInstructionsPath(targetRoot);
}

function buildIntegrationAttrs(
  projectKey: string | undefined,
  sqaaEnabled: boolean,
): Record<string, IntegrationStateAttribute> {
  return {
    projectKey: projectKey ?? null,
    sqaaEnabled,
  };
}

function expectedSqaaInstructionsPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_INSTRUCTIONS_REL_DIR, INSTRUCTIONS_FILENAME);
}
