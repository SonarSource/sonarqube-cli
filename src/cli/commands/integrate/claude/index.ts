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
import { isEnvBasedAuth, isSonarQubeCloud } from '../../../../lib/auth-resolver';
import {
  OBSOLETE_A3S_MARKER,
  removeObsoleteHookArtifacts,
  runMigrations,
} from '../../../../lib/migration';
import { type DiscoveredProject, discoverProject } from '../../../../lib/project-workspace';
import type { IntegrationScope, IntegrationStateAttribute } from '../../../../lib/state';
import { blank, discreetSuccess, intro, text, warn } from '../../../../ui';
import { CommandFailedError } from '../../_common/error';
import {
  buildContextAugmentationAttrs,
  resolveContextAugmentationSetup,
} from '../_common/context-augmentation';
import { installIntegration } from '../_common/registry';
import { resolveSqaaEntitlement } from '../_common/sqaa-entitlement';
import type { IntegrateAgentOptions } from '../_common/types';
import { CLAUDE_INTEGRATION_ID, type ClaudeIntegrationOptions } from './declaration';
import { runHealthChecks } from './health';
import { detectGlobalSecretsHook } from './hooks';
import { repairToken } from './repair';
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
  intro(`SonarQube Integration Setup for Claude Code`);

  blank();
  text('Phase 1/3: Discovery & Validation');
  blank();

  const project = await discoverProject(process.cwd());
  const config = loadConfiguration(project, options, auth);
  validateConfiguration(project, config, options.global ?? false);

  const isGlobal = options.global ?? false;
  // For project-level installs, probe the user home for a pre-existing global
  // Claude hook. The detector emits info/warn for installed/orphaned and
  // returns the hook dir when we should skip project-level secrets hooks.
  const existingGlobalHookPath = isGlobal ? undefined : await detectGlobalSecretsHook(homedir());
  const skipSecretsHooks = !!existingGlobalHookPath;
  // Health check looks at the directory that actually owns the secrets hooks.
  const hooksRoot = isGlobal || skipSecretsHooks ? homedir() : project.rootDir;
  const globalDir = isGlobal ? homedir() : undefined;

  let token = config.token;

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
    discreetSuccess('All checks passed! Configuration is healthy.');
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
}

/**
 * Load configuration from auth and discovered project
 */
function loadConfiguration(
  project: DiscoveredProject,
  options: IntegrateAgentOptions,
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

function validateConfiguration(
  project: DiscoveredProject,
  config: ConfigurationData,
  isGlobal: boolean,
): void {
  if (isSonarQubeCloud(config.serverURL) && !config.organization) {
    throw new CommandFailedError('SonarQube Cloud requires an organization.', {
      remediationHint:
        "Run 'sonar auth logout' and then 'sonar auth login' with a SonarQube Cloud organization.",
    });
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
  } else if (!isGlobal) {
    warn(
      'No project key provided - project related actions will be skipped. Run sonar integrate claude --help for ways to define a project.',
    );
  }
}

function buildIntegrationAttrs(
  config: ConfigurationData,
): Record<string, IntegrationStateAttribute> {
  return {
    projectKey: config.projectKey ?? null,
  };
}
