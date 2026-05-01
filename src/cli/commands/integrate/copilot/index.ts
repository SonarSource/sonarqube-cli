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
import { intro, print } from '../../../../ui';
import { InvalidOptionError } from '../../_common/error';
import { setupMcpServer } from './mcp';
import { installSecretsBinary } from '../../_common/install/secrets';
import { detectGlobalSecretsHook, installPreToolUseHook } from './hooks';
import {
  detectGlobalPromptSecretsInstructions,
  installPromptSecretsInstructions,
} from './instructions';
import { updateCopilotState } from './state';

export interface IntegrateCopilotOptions {
  project?: string;
  nonInteractive?: boolean;
  global?: boolean;
}

export async function integrateCopilot(_auth: ResolvedAuth, options: IntegrateCopilotOptions) {
  if (options.global && options.project) {
    throw new InvalidOptionError(
      '--global and --project are mutually exclusive; please specify only one scope.',
    );
  }

  intro('SonarQube integration for Copilot');

  const project = await discoverProject(process.cwd());
  for (const configSource of project.configSources) {
    print(`Found ${configSource}`);
  }

  const isGlobal = options.global ?? false;

  // For project-level installs, probe ~/.copilot/hooks for an existing global
  // sonar-secrets hook so we don't double-scan every file the agent reads.
  // The detector emits its own user-facing message describing what it found.
  const skipHookInstall = !isGlobal && (await detectGlobalSecretsHook());

  // Same rationale as the hook: a project-level instructions file would just
  // duplicate the global one, so skip when the global file is already in place.
  const skipInstructions = !isGlobal && detectGlobalPromptSecretsInstructions();

  await installSecretsBinary();

  if (!skipHookInstall) {
    await installPreToolUseHook(project.rootDir, isGlobal);
  }

  if (!skipInstructions) {
    await installPromptSecretsInstructions(project.rootDir, isGlobal);
  }

  updateCopilotState(project.rootDir, isGlobal, {
    hookInstalled: !skipHookInstall,
    instructionsInstalled: !skipInstructions,
  });

  await setupMcpServer(project, options.global ?? false, options.project || project.projectKey);
}
