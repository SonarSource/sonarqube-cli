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
import { intro, print, success } from '../../../../ui';
import { InvalidOptionError } from '../../_common/error';
import { setupMcpServer } from './mcp';
import { installSecretsBinary } from '../../_common/install/secrets';
import type { IntegrateAgentOptions } from '../_common/options';
import { detectGlobalSecretsHook, installPreToolUseHook } from './hooks';
import {
  detectGlobalPromptSecretsInstructions,
  installPromptSecretsInstructions,
} from './instructions';
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
  // Detect existing configuration
  const isGlobal = options.global ?? false;
  // For project-level installs, probe ~/.copilot for an existing global
  // sonar-secrets hook / instructions file so we don't duplicate them.
  const existingGlobalHookPath = isGlobal ? undefined : await detectGlobalSecretsHook();
  const skipHookInstall = !!existingGlobalHookPath;
  const existingGlobalInstructionsPath = isGlobal
    ? undefined
    : detectGlobalPromptSecretsInstructions();
  const skipInstructions = !!existingGlobalInstructionsPath;

  // ============
  // Installation
  // ============
  await installSecretsBinary();
  if (!skipHookInstall) {
    await installPreToolUseHook(project.rootDir, isGlobal);
  }
  if (!skipInstructions) {
    await installPromptSecretsInstructions(project.rootDir, isGlobal);
  }
  await updateCopilotState(project.rootDir, isGlobal, {
    hookInstalled: !skipHookInstall,
    instructionsInstalled: !skipInstructions,
  });

  await setupMcpServer(project, options.global ?? false, options.project || project.projectKey);

  reportInstallationOutcome(isGlobal, existingGlobalHookPath, existingGlobalInstructionsPath);
}

/**
 * Print the scope-aware outcome after installation completes.
 * Surfaces the existing global hook / instructions paths when project-level
 * installs were skipped so the user knows where the active files live.
 */
function reportInstallationOutcome(
  isGlobal: boolean,
  existingGlobalHookPath: string | undefined,
  existingGlobalInstructionsPath: string | undefined,
): void {
  if (existingGlobalHookPath) {
    success(
      `Copilot integration configured. Secrets scanning will use the existing global hook at: ${existingGlobalHookPath}`,
    );
    return;
  }
  if (existingGlobalInstructionsPath) {
    success(
      `Copilot integration configured. Prompt secrets instructions will use the existing global file at: ${existingGlobalInstructionsPath}`,
    );
    return;
  }
  if (isGlobal) {
    success('Copilot integration successfully configured globally');
  } else {
    success('Copilot integration successfully configured at the project level');
  }
}
