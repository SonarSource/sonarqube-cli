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
import type { IntegrateAgentOptions } from '../_common/types';
import { installHooks } from './hooks';
import { installInstructions } from './instructions';
import { setupMcpServer } from './mcp';
import { updateCopilotState } from './state';

export async function integrateCopilot(_auth: ResolvedAuth, options: IntegrateAgentOptions) {
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
      'No project key provided - project related actions will be skipped. Run sonar integrate copilot --help for ways to define a project.',
    );
  }

  // ============
  // Installation
  // ============
  const { hookPath, hookInstalled } = await installHooks(project.rootDir, isGlobal);
  const { instructionsPath, instructionsInstalled } = await installInstructions(
    project.rootDir,
    isGlobal,
  );

  await updateCopilotState(project.rootDir, isGlobal, {
    hookInstalled,
    instructionsInstalled,
  });

  await setupMcpServer(project, isGlobal, projectKey);

  reportInstallationOutcome(isGlobal, hookPath, instructionsPath);
}

function reportInstallationOutcome(
  isGlobal: boolean,
  hookPath: string | undefined,
  instructionsPath: string | undefined,
): void {
  const scope = isGlobal
    ? 'Copilot integration successfully configured globally'
    : 'Copilot integration successfully configured at the project level';
  const hookLine = hookPath ? `Hook: ${hookPath}` : 'Hook: not installed (see warning above)';
  const instructionsLine = instructionsPath
    ? `Instructions: ${instructionsPath}`
    : 'Instructions: not installed (see warning above)';
  success(`${scope}\n${hookLine}\n${instructionsLine}`);
}
