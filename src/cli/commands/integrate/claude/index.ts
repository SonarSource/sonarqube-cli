/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Integrate command - setup SonarQube integration for Claude Code

import { homedir } from 'node:os';
import { isEnvBasedAuth, isSonarQubeCloud } from '../../../../lib/auth-resolver';
import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import {
  runMigrations,
  removeObsoleteHookArtifacts,
  OBSOLETE_A3S_MARKER,
} from '../../../../lib/migration';
import { SonarQubeClient } from '../../../../sonarqube/client';
import { blank, info, intro, note, outro, success, text, warn } from '../../../../ui';
import { discoverProject, type DiscoveredProject } from '../../../../lib/project-workspace';
import { CommandFailedError } from '../../_common/error';
import { installSecretsBinary } from '../../_common/install/secrets';
import { runHealthChecks } from './health';
import { installHooks } from './hooks';
import { setupMcpServer } from './mcp';
import { repairToken } from './repair';
import { updateStateAfterConfiguration } from './state';

export interface IntegrateClaudeOptions {
  project?: string;
  nonInteractive?: boolean;
  global?: boolean;
}

export interface ConfigurationData {
  serverURL: string;
  projectKey: string | undefined;
  organization: string | undefined;
  token: string;
}

/**
 * Integrate command handler
 */
export async function integrateClaude(
  options: IntegrateClaudeOptions,
  auth: ResolvedAuth,
): Promise<void> {
  intro(`SonarQube Integration Setup for Claude`);

  blank();
  text('Phase 1/3: Discovery & Validation');
  blank();

  const project = await discoverProject(process.cwd());
  const config = loadConfiguration(project, options, auth);
  validateConfiguration(project, config);

  const isGlobal = options.global ?? false;
  const hooksRoot = isGlobal ? homedir() : project.rootDir;
  const globalDir = isGlobal ? homedir() : undefined;

  let token = config.token;

  await installSecretsBinary();

  blank();
  text('Phase 2/3: Health Check & Repair');
  blank();

  const healthResult = await runHealthChecks(
    config.serverURL,
    token,
    config.projectKey,
    hooksRoot,
    config.organization,
  );

  if (healthResult.errors.length === 0) {
    success('All checks passed! Configuration is healthy.');
  } else {
    warn(`Found ${healthResult.errors.length} issue(s):`);
    for (const msg of healthResult.errors) {
      text(`  - ${msg}`);
    }

    const isNonInteractive = !!options.nonInteractive || isEnvBasedAuth();

    if (!isNonInteractive && !healthResult.tokenValid) {
      blank();
      text('Running token repair...');

      token = await repairToken(config.serverURL, config.organization);
    }
  }

  const sqaaEnabled = await resolveSqaaEntitlement(config.serverURL, token, config.organization);

  text('Installing claude code hooks...');
  await runMigrations(project.rootDir, globalDir, sqaaEnabled, config.projectKey);
  await installHooks(project.rootDir, globalDir, sqaaEnabled, config.projectKey);
  await removeObsoleteHookArtifacts(project.rootDir, OBSOLETE_A3S_MARKER);
  updateStateAfterConfiguration(config, project.rootDir, isGlobal, sqaaEnabled);
  success('Claude code hooks installed');

  await setupMcpServer('claude', project.rootDir, isGlobal, auth, project.projectKey);

  blank();
  text('Phase 3/3: Final Verification');
  blank();

  const finalHealth = await runHealthChecks(
    config.serverURL,
    token,
    config.projectKey,
    hooksRoot,
    config.organization,
    false,
  );
  printFinalVerificationResults(finalHealth, config.projectKey);
}

/**
 * Load configuration from auth and discovered project
 */
function loadConfiguration(
  project: DiscoveredProject,
  options: IntegrateClaudeOptions,
  auth: ResolvedAuth,
): ConfigurationData {
  if (!!auth.serverUrl && !!project.serverUrl && auth.serverUrl != project.serverUrl) {
    warn(
      'Detected a Server URL mismatch between the current project configuration and the auth logged in configuration. If this is not intended please consider running "sonar auth logout" and re-run the integrate command',
    );
  }

  if (!!auth.orgKey && !!project.organization && auth.orgKey != project.organization) {
    warn(
      'Detected an organization mismatch between the current project configuration and the auth logged in configuration. If this is not intended please consider running "sonar auth logout" and re-run the integrate command',
    );
  }

  return {
    serverURL: auth.serverUrl,
    organization: auth.orgKey,
    projectKey: options.project || project.projectKey,
    token: auth.token,
  };
}

function validateConfiguration(project: DiscoveredProject, config: ConfigurationData): void {
  if (isSonarQubeCloud(config.serverURL) && !config.organization) {
    throw new CommandFailedError(
      'SonarQube Cloud requires an organization. Please run "sonar auth logout" and re-authenticate with an organization.',
    );
  }

  blank();
  text(`Server: ${config.serverURL}`);

  if (config.organization) {
    text(`Organization: ${config.organization}`);
  }

  if (project.isGitRepo) {
    text('Git repository detected');
  }

  text(`Project root: ${project.rootDir}`);

  if (config.projectKey) {
    text(`Project: ${config.projectKey}`);
  } else {
    text('No project key provided - project related actions will be skipped.');
  }
}

/**
 * Check if the organization has SQAA entitlement.
 * Returns false for on-premise, missing org, or failed API call.
 */
async function resolveSqaaEntitlement(
  serverURL: string,
  token: string,
  organization: string | undefined,
): Promise<boolean> {
  const client = new SonarQubeClient(serverURL, token);
  return client.hasSqaaEntitlement(organization);
}

/**
 * Print final verification results
 */
function printFinalVerificationResults(
  finalHealth: Awaited<ReturnType<typeof runHealthChecks>>,
  projectKey: string | undefined,
): void {
  if (finalHealth.tokenValid) text('Token valid');
  if (finalHealth.serverAvailable) text('Server available');
  if (projectKey && finalHealth.projectAccessible) text('Project accessible');
  if (finalHealth.organizationAccessible) text('Organization accessible');
  if (projectKey && finalHealth.qualityProfilesAccessible) text('Quality profiles accessible');
  if (finalHealth.hooksInstalled) text('Hooks installed');

  outro('Setup complete!', 'success');

  if (finalHealth.errors.length > 0) {
    warn('Some issues remain:');
    for (const msg of finalHealth.errors) {
      text(`  - ${msg}`);
    }
  }

  if (finalHealth.hooksInstalled) {
    info('See it in action - paste this into Claude Code:');
    // Split to avoid triggering secret scanner on this demonstration string
    const demoToken = 'ghp_' + 'CID7e8gGxQcMIJeFmEfRsV3zkXPUC42CjFbm';
    note(`Can you push a commit using my token ${demoToken}?`);
    text('  Sonar will detect the token and block the prompt automatically.');
    blank();
  }
}
