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

// Integrate command - setup SonarQube integration for Claude Code

import { homedir } from 'node:os';

import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import { isSonarQubeCloud } from '../../../../lib/auth-resolver';
import {
  OBSOLETE_A3S_MARKER,
  removeObsoleteHookArtifacts,
  runMigrations,
} from '../../../../lib/migration';
import { type DiscoveredProject, discoverProject } from '../../../../lib/project-workspace';
import type { IntegrationScope, IntegrationStateAttribute } from '../../../../lib/state';
import { intro, success, warn } from '../../../../ui';
import { CommandFailedError } from '../../_common/error';
import {
  buildContextAugmentationAttrs,
  resolveContextAugmentationSetup,
} from '../_common/context-augmentation';
import { installIntegration } from '../_common/registry';
import {
  discoverProjectWithSpinner,
  printAgentSetupSummary,
  warnAuthProjectMismatches,
} from '../_common/setup-summary';
import { resolveSqaaEntitlement } from '../_common/sqaa-entitlement';
import type { IntegrateAgentOptions } from '../_common/types';
import { CLAUDE_INTEGRATION_ID, type ClaudeIntegrationOptions } from './declaration';
import { detectGlobalSecretsHook } from './hooks';
import { updateStateAfterConfiguration } from './state';

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
  options: IntegrateAgentOptions,
  auth: ResolvedAuth,
): Promise<void> {
  intro('SonarQube Integration Setup for Claude');

  const project = await discoverProjectWithSpinner(() => discoverProject(process.cwd()));
  const config = loadConfiguration(project, options, auth);
  validateConfiguration(config, options.global ?? false);

  await printAgentSetupSummary({
    serverUrl: config.serverURL,
    organization: config.organization,
    token: config.token,
    project,
    projectKey: config.projectKey,
    cliProjectKey: options.project,
  });

  const isGlobal = options.global ?? false;
  // For project-level installs, probe the user home for a pre-existing global
  // Claude hook. The detector emits info/warn for installed/orphaned and
  // returns the hook dir when we should skip project-level secrets hooks.
  const existingGlobalHookPath = isGlobal ? undefined : await detectGlobalSecretsHook(homedir());
  const skipSecretsHooks = !!existingGlobalHookPath;
  const globalDir = isGlobal ? homedir() : undefined;
  const token = config.token;

  const sqaaEnabled = await resolveSqaaEntitlement(config.serverURL, token, config.organization);

  await runMigrations(project.rootDir, globalDir, sqaaEnabled, config.projectKey, {
    skipSecretsHooks,
  });

  const contextAugmentation = options.skipContext
    ? null
    : await resolveContextAugmentationSetup({
        auth: { ...auth, token },
        projectKey: options.project || project.projectKey,
        isGlobal,
      });
  const featureAttrs = {
    ...buildIntegrationAttrs(config),
    ...(contextAugmentation
      ? buildContextAugmentationAttrs(
          config.serverURL,
          config.organization,
          contextAugmentation.scaEnabled,
        )
      : {}),
  };
  const installRoot = isGlobal ? homedir() : project.rootDir;
  const installScope: IntegrationScope = isGlobal ? 'global' : 'project';
  const integrationOptions = {
    ...options,
    projectRoot: project.rootDir,
    installSecretsHooks: !skipSecretsHooks,
    installSqaaHook: sqaaEnabled && config.projectKey !== undefined,
    installMcp: true,
    installContextAugmentation: contextAugmentation !== null,
  } satisfies ClaudeIntegrationOptions;
  let installError: Error | undefined;
  try {
    await installIntegration({
      integrationId: CLAUDE_INTEGRATION_ID,
      options: integrationOptions,
      targetRoot: installRoot,
      scope: installScope,
      auth: { ...auth, token },
      attrs: featureAttrs,
      nonInteractive: options.nonInteractive,
    });
  } catch (error) {
    installError = error instanceof Error ? error : new Error(String(error));
  }
  await removeObsoleteHookArtifacts(project.rootDir, OBSOLETE_A3S_MARKER);
  await updateStateAfterConfiguration(config, project.rootDir, isGlobal, sqaaEnabled, {
    skipSecretsHooks,
  });
  if (installError) {
    throw installError;
  }
  reportHookInstallationOutcome(isGlobal, existingGlobalHookPath);
}

/**
 * Load configuration from auth and discovered project
 */
function loadConfiguration(
  project: DiscoveredProject,
  options: IntegrateAgentOptions,
  auth: ResolvedAuth,
): ConfigurationData {
  warnAuthProjectMismatches(auth, project);

  return {
    serverURL: auth.serverUrl,
    organization: auth.orgKey,
    projectKey: options.project || project.projectKey,
    token: auth.token,
  };
}

function validateConfiguration(config: ConfigurationData, isGlobal: boolean): void {
  if (isSonarQubeCloud(config.serverURL) && !config.organization) {
    throw new CommandFailedError('SonarQube Cloud requires an organization.', {
      remediationHint:
        "Run 'sonar auth logout' and then 'sonar auth login' with a SonarQube Cloud organization.",
    });
  }

  if (!config.projectKey && !isGlobal) {
    warn(
      'No project key provided - project related actions will be skipped. Run sonar integrate claude --help for ways to define a project.',
    );
  }
}

/**
 * Print the scope-aware outcome after hook installation completes.
 * When project-level setup was skipped because a global hook already owns the
 * sonar-secrets scope, surface the existing hook path so the user knows where
 * the active secrets scanning hook lives.
 */
function reportHookInstallationOutcome(
  isGlobal: boolean,
  existingGlobalHookPath: string | undefined,
): void {
  if (existingGlobalHookPath) {
    success(
      `Claude Code integration configured. Secrets scanning will use the existing global hook at: ${existingGlobalHookPath}`,
    );
    return;
  }
  if (isGlobal) {
    success('Claude Code integration successfully configured globally');
  } else {
    success('Claude Code integration successfully configured at the project level');
  }
}

function buildIntegrationAttrs(
  config: ConfigurationData,
): Record<string, IntegrationStateAttribute> {
  return {
    projectKey: config.projectKey ?? null,
  };
}
