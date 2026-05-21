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
import { discoverProject } from '../../../../lib/project-workspace';
import { intro, print, success, warn } from '../../../../ui';
import { InvalidOptionError } from '../../_common/error';
import { setupContextAugmentation } from '../_common/context-augmentation';
import { resolveSqaaEntitlement } from '../_common/sqaa-entitlement';
import type { IntegrateAgentOptions } from '../_common/types';
import { installHooks } from './hooks';
import type { InstructionsInstallResult } from './instructions';
import { installInstructions } from './instructions';
import { setupMcpServer } from './mcp';
import { updateCopilotState } from './state';

export async function integrateCopilot(auth: ResolvedAuth, options: IntegrateAgentOptions) {
  if (options.global && options.project) {
    throw new InvalidOptionError(
      '--global and --project are mutually exclusive; please specify only one scope.',
    );
  }

  intro('SonarQube integration for Copilot');

  // =========
  // Discovery
  // =========

  // Discover project
  const project = await discoverProject(process.cwd());
  for (const configSource of project.configSources) {
    print(`Found ${configSource}`);
  }
  const isGlobal = options.global ?? false;
  const projectKey = options.project || project.projectKey;
  if (!isGlobal && !projectKey) {
    warn(
      'No project key provided - project related actions will be skipped. Run `sonar integrate copilot --help` for ways to define a project.',
    );
  }

  const entitled = await resolveSqaaEntitlement(auth.serverUrl, auth.token, auth.orgKey);
  const sqaaProjectKey = entitled && projectKey ? projectKey : undefined;

  // ============
  // Installation
  // ============
  const { hookPath, hookInstalled } = await installHooks(project.rootDir, isGlobal);
  const instructions = await installInstructions(project.rootDir, isGlobal, sqaaProjectKey);

  await updateCopilotState(project.rootDir, isGlobal, {
    hookInstalled,
    promptSecretsInstructionsInstalled: instructions.promptSecrets.installed,
    sqaaInstructionsInstalled: instructions.sqaa.installed,
    projectKey: instructions.sqaa.installed ? sqaaProjectKey : undefined,
    orgKey: instructions.sqaa.installed ? auth.orgKey : undefined,
    serverUrl: instructions.sqaa.installed ? auth.serverUrl : undefined,
  });

  await setupMcpServer(project, isGlobal, projectKey);

  if (!options.skipContext) {
    await setupContextAugmentation({
      auth,
      agent: 'copilot',
      projectRoot: project.rootDir,
      projectKey,
      isGlobal,
    });
  }

  reportInstallationOutcome(isGlobal, hookPath, instructions);
}

function reportInstallationOutcome(
  isGlobal: boolean,
  hookPath: string | undefined,
  instructions: InstructionsInstallResult,
): void {
  const scope = isGlobal
    ? 'Copilot integration successfully configured globally'
    : 'Copilot integration successfully configured at the project level';
  const hookLine = hookPath ? `Hook: ${hookPath}` : 'Hook: not installed (see warning above)';
  const instructionsLines = formatInstructionsLines(instructions);
  success([scope, hookLine, ...instructionsLines].join('\n'));
}

function formatInstructionsLines(instructions: InstructionsInstallResult): string[] {
  const { promptSecrets, sqaa } = instructions;
  const lines: string[] = [];
  if (!promptSecrets.installed || !promptSecrets.path) {
    lines.push('Instructions (secrets scanning for prompts): not installed (see warning above)');
  } else if (sqaa.installed && sqaa.path === promptSecrets.path) {
    lines.push(
      `Instructions (secrets scanning for prompts, SonarQube Agentic Analysis): ${promptSecrets.path}`,
    );
  } else {
    lines.push(`Instructions (secrets scanning for prompts): ${promptSecrets.path}`);
  }
  if (sqaa.installed && sqaa.path && sqaa.path !== promptSecrets.path) {
    lines.push(`Instructions (SonarQube Agentic Analysis): ${sqaa.path}`);
  }
  return lines;
}
