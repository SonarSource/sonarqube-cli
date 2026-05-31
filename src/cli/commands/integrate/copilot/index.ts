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
import type { IntegrateAgentOptions } from '../_common/types';
import { COPILOT_INTEGRATION_ID, type CopilotIntegrationOptions } from './declaration';
import { hookScriptName, PROJECT_HOOKS_REL_DIR, SCRIPT_REL_DIR } from './hooks';
import { INSTRUCTIONS_FILENAME, PROJECT_INSTRUCTIONS_REL_DIR } from './instructions';

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

  const targetRoot = isGlobal ? homedir() : project.rootDir;
  const scope: IntegrationScope = isGlobal ? 'global' : 'project';

  const integrationOptions: CopilotIntegrationOptions = {
    ...options,
    projectRoot: project.rootDir,
    serverURL: auth.serverUrl,
    token: auth.token,
    organization: auth.orgKey,
    projectKey: projectKey ?? undefined,
  };

  const installed = await installIntegration({
    integrationId: COPILOT_INTEGRATION_ID,
    options: integrationOptions,
    targetRoot,
    scope,
    attrs: { projectKey: projectKey ?? null },
    nonInteractive: options.nonInteractive,
  });

  const sqaaInstalled = installed.some((feature) => feature.featureId === 'sqaa-instructions');

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
    hookPath: expectedHookPath(targetRoot, scope),
    promptInstructionsPath: expectedPromptInstructionsPath(targetRoot, scope),
    sqaaInstructionsPath: sqaaInstalled ? expectedSqaaInstructionsPath(project.rootDir) : undefined,
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

function expectedSqaaInstructionsPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_INSTRUCTIONS_REL_DIR, INSTRUCTIONS_FILENAME);
}
