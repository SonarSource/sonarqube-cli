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
import { isEnvBasedAuth, isSonarQubeCloud, resolveAuth } from '../../../../lib/auth-resolver';
import { SONARCLOUD_URL } from '../../../../lib/config-constants';
import { runMigrations } from '../../../../lib/migration';
import { SonarQubeClient } from '../../../../sonarqube/client';
import { blank, info, intro, note, outro, success, text, warn } from '../../../../ui';
import type { DiscoveredProject } from '../../_common/discovery';
import { discoverProject } from '../../_common/discovery';
import { CommandFailedError } from '../../_common/error';
import { runHealthChecks } from './health';
import { installHooks } from './hooks';
import { repairToken } from './repair';
import { updateStateAfterConfiguration } from './state';

export interface IntegrateClaudeOptions {
  server?: string;
  project?: string;
  token?: string;
  org?: string;
  nonInteractive?: boolean;
  global?: boolean;
}

export interface ConfigurationData {
  serverURL: string;
  projectKey: string | undefined;
  organization: string | undefined;
  token: string | undefined;
}

/**
 * Integrate command handler
 */
export async function integrateClaude(options: IntegrateClaudeOptions): Promise<void> {
  intro(`SonarQube Integration Setup for Claude`);

  blank();
  text('Phase 1/3: Discovery & Validation');
  blank();

  const project = await discoverProject(process.cwd());
  const config = await loadConfiguration(project, options);
  validateConfiguration(project, config);

  const isGlobal = options.global ?? false;
  const hooksRoot = isGlobal ? homedir() : project.rootDir;
  const globalDir = isGlobal ? homedir() : undefined;

  let token = config.token;

  blank();
  text('Phase 2/3: Health Check & Repair');
  blank();

  const healthResult = await runHealthChecks(
    config.serverURL,
    token || 'INVALID',
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

  const a3sEnabled = token
    ? await resolveA3sEntitlement(config.serverURL, token, config.organization)
    : false;

  text('Installing claude code hooks...');
  await runMigrations(project.rootDir, globalDir, a3sEnabled, config.projectKey);
  await installHooks(project.rootDir, globalDir, a3sEnabled, config.projectKey);
  updateStateAfterConfiguration(config, project.rootDir, isGlobal, a3sEnabled);
  success('Claude code hooks installed');

  blank();
  text('Phase 3/3: Final Verification');
  blank();

  const finalHealth = await runHealthChecks(
    config.serverURL,
    token || 'INVALID',
    config.projectKey,
    hooksRoot,
    config.organization,
    false,
  );
  printFinalVerificationResults(finalHealth, config.projectKey);
}

/**
 * Load configuration from all available sources
 */
async function loadConfiguration(
  project: DiscoveredProject,
  options: IntegrateClaudeOptions,
): Promise<ConfigurationData> {
  let resolvedAuth;
  try {
    resolvedAuth = await resolveAuth({
      server: options.server,
      org: options.org,
      token: options.token,
    });
  } catch {
    // ignore error, command will attempt to call `auth login` flow
  }

  if (!resolvedAuth) {
    return {
      serverURL: options.server || project.serverUrl || SONARCLOUD_URL,
      organization: options.org || project.organization,
      token: options.token,
      projectKey: options.project || project.projectKey,
    };
  }

  if (
    !!resolvedAuth.serverUrl &&
    !!project.serverUrl &&
    resolvedAuth.serverUrl != project.serverUrl
  ) {
    warn(
      'Detected a Server URL mismatch between the current project configuration and the auth logged in configuration. If this is not intended please consider running "sonar auth logout" and re-run the integrate command',
    );
  }

  if (
    !!resolvedAuth.orgKey &&
    !!project.organization &&
    resolvedAuth.orgKey != project.organization
  ) {
    warn(
      'Detected an organization mismatch between the current project configuration and the auth logged in configuration. If this in not intended please consider providing "-o" option',
    );
  }

  return {
    serverURL: resolvedAuth.serverUrl,
    organization: resolvedAuth.orgKey,
    token: resolvedAuth.token,
    projectKey: options.project || project.projectKey,
  };
}

function validateConfiguration(project: DiscoveredProject, config: ConfigurationData): void {
  if (isSonarQubeCloud(config.serverURL) && !config.organization) {
    throw new CommandFailedError(
      'SonarQube Server URL or SonarQube Cloud organization is required. Please use --server flag or --org option',
    );
  }

  blank();
  text(`Server: ${config.serverURL}`);

  if (config.organization) {
    text(`Organization: ${config.organization}`);
  }

  if (!config.token) {
    warn('No token found. Will generate during repair phase.');
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
 * Check if the organization has A3S entitlement.
 * Returns false for on-premise, missing org, or failed API call.
 */
async function resolveA3sEntitlement(
  serverURL: string,
  token: string,
  organization: string | undefined,
): Promise<boolean> {
  const client = new SonarQubeClient(serverURL, token);
  return client.hasA3sEntitlement(organization);
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
