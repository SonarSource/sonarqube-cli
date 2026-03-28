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

// Integrate command - setup SonarQube integration for OpenAI Codex (MCP + sonar-secrets hooks, same layout as Claude)

import { homedir } from 'node:os';
import { join } from 'node:path';
import { isEnvBasedAuth } from '../../../../lib/auth-resolver';
import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import { CODEX_AGENT_DIR_NAME, CODEX_USER_CONFIG_FILE } from '../../../../lib/config-constants';
import {
  removeObsoleteCodexHookArtifacts,
  runCodexMigrations,
  OBSOLETE_A3S_MARKER,
} from '../../../../lib/migration';
import { isDockerAvailable } from '../../../../lib/tool-detector';
import { blank, info, intro, note, outro, success, text, warn } from '../../../../ui';
import { discoverProject } from '../../_common/discovery';
import {
  loadIntegrateConfiguration,
  validateIntegrateConfiguration,
} from '../_common/integrate-configuration';
import { installSecretsBinary } from '../../_common/install/secrets';
import { repairToken } from '../claude/repair';
import { resolveSqaaEntitlement } from '../_common/sqaa-entitlement';
import {
  mergeCodexHooksFeatureProjectLayerIfPresent,
  mergeCodexHooksFeatureUserLayerIfPresent,
  writeCodexTomlIntegration,
} from './codex-config';
import { installCodexHooks, isCodexHooksSupportedOnPlatform } from './hooks';
import { runCodexHealthChecks, type CodexHealthCheckResult } from './health';
import { updateStateAfterCodexConfiguration } from './state';

export interface IntegrateCodexOptions {
  project?: string;
  nonInteractive?: boolean;
  /** When true, install hooks and MCP under ~/.codex (default: project .codex only, same as integrate claude). */
  global?: boolean;
}

type DiscoveredProject = Awaited<ReturnType<typeof discoverProject>>;
type IntegrateConfig = ReturnType<typeof loadIntegrateConfiguration>;

async function resolveTokenAfterInitialHealth(
  options: IntegrateCodexOptions,
  healthResult: CodexHealthCheckResult,
  config: IntegrateConfig,
): Promise<string> {
  let token = config.token;

  if (healthResult.errors.length === 0) {
    success('All checks passed! Configuration is healthy.');
    return token;
  }

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
  return token;
}

function printFinalVerificationSummary(
  finalHealth: CodexHealthCheckResult,
  config: IntegrateConfig,
): void {
  if (finalHealth.tokenValid) text('Token valid');
  if (finalHealth.serverAvailable) text('Server available');
  if (config.projectKey && finalHealth.projectAccessible) text('Project accessible');
  if (finalHealth.organizationAccessible) text('Organization accessible');
  if (config.projectKey && finalHealth.qualityProfilesAccessible)
    text('Quality profiles accessible');
  if (finalHealth.mcpConfigured) text('Codex MCP configured in config.toml');
  if (finalHealth.hooksInstalled) text('Hooks installed');
}

function printRemainingVerificationIssues(finalHealth: CodexHealthCheckResult): void {
  if (finalHealth.errors.length === 0) {
    return;
  }
  warn('Some issues remain:');
  for (const msg of finalHealth.errors) {
    text(`  - ${msg}`);
  }
}

interface RunCodexConfigureParams {
  project: DiscoveredProject;
  auth: ResolvedAuth;
  isGlobal: boolean;
  hooksSupported: boolean;
  configTomlPath: string;
  sqaaEnabled: boolean;
  globalDir: string | undefined;
  projectKey: string | undefined;
}

async function tryInstallCodexHooks(
  hooksSupported: boolean,
  projectRoot: string,
  globalDir: string | undefined,
  sqaaEnabled: boolean,
  projectKey: string | undefined,
): Promise<{ secretsHooksInstalled: boolean; sqaaHookInstalled: boolean }> {
  let secretsHooksInstalled = false;
  let sqaaHookInstalled = false;

  if (!hooksSupported) {
    warn('Codex hooks are not supported on Windows; skipping secrets hooks.');
    return { secretsHooksInstalled, sqaaHookInstalled };
  }

  text('Installing Codex hooks...');
  await runCodexMigrations(projectRoot, globalDir, sqaaEnabled, projectKey);
  ({ secretsHooksInstalled, sqaaHookInstalled } = await installCodexHooks(
    projectRoot,
    globalDir,
    sqaaEnabled,
    projectKey,
  ));
  await removeObsoleteCodexHookArtifacts(projectRoot, OBSOLETE_A3S_MARKER);
  if (secretsHooksInstalled || sqaaHookInstalled) {
    success('Codex hooks installed');
  } else {
    warn('No Codex hooks were installed.');
  }
  return { secretsHooksInstalled, sqaaHookInstalled };
}

async function mergeCodexHookFeatureLayers(
  isGlobal: boolean,
  hooksSupported: boolean,
  projectRoot: string,
  secretsHooksInstalled: boolean,
  sqaaHookInstalled: boolean,
): Promise<void> {
  const hooksOn = secretsHooksInstalled || sqaaHookInstalled;
  if (!isGlobal && hooksOn) {
    const mergedUser = await mergeCodexHooksFeatureUserLayerIfPresent();
    if (mergedUser) {
      info(
        'Enabled [features] codex_hooks in ~/.codex/config.toml so merged session config matches project hooks.',
      );
    }
  }

  if (hooksSupported && hooksOn) {
    const mergedProject = await mergeCodexHooksFeatureProjectLayerIfPresent(projectRoot);
    if (mergedProject && isGlobal) {
      info(
        'Updated project .codex/config.toml: [features] codex_hooks = true (project layer overrides ~/.codex in Codex; hooks stay off if this stays false).',
      );
    }
  }
}

async function runCodexConfigure(params: RunCodexConfigureParams): Promise<{
  dockerAvailable: boolean;
  secretsHooksInstalled: boolean;
  sqaaHookInstalled: boolean;
}> {
  const {
    project,
    auth,
    isGlobal,
    hooksSupported,
    configTomlPath,
    sqaaEnabled,
    globalDir,
    projectKey,
  } = params;

  const { secretsHooksInstalled, sqaaHookInstalled } = await tryInstallCodexHooks(
    hooksSupported,
    project.rootDir,
    globalDir,
    sqaaEnabled,
    projectKey,
  );

  const dockerAvailable = await isDockerAvailable();

  if (dockerAvailable) {
    info('Configuring SonarQube MCP Server in Codex config.toml...');
  } else {
    warn(
      'Docker is required for the SonarQube MCP Server. Install Docker and re-run sonar integrate codex.',
    );
  }

  await writeCodexTomlIntegration({
    configFilePath: configTomlPath,
    auth,
    isGlobal,
    projectRoot: project.rootDir,
    projectKey,
    includeMcp: dockerAvailable,
    includeHooksFeature: secretsHooksInstalled || sqaaHookInstalled,
  });

  if (dockerAvailable) {
    success(`Codex MCP config written to ${configTomlPath}`);
  }

  await mergeCodexHookFeatureLayers(
    isGlobal,
    hooksSupported,
    project.rootDir,
    secretsHooksInstalled,
    sqaaHookInstalled,
  );

  return { dockerAvailable, secretsHooksInstalled, sqaaHookInstalled };
}

export async function integrateCodex(
  options: IntegrateCodexOptions,
  auth: ResolvedAuth,
): Promise<void> {
  intro(`SonarQube Integration Setup for Codex`);

  blank();
  text('Phase 1/3: Discovery & Validation');
  blank();

  const project = await discoverProject(process.cwd());
  const config = loadIntegrateConfiguration(project, options, auth);
  validateIntegrateConfiguration(
    project,
    config,
    'No project key provided - project related actions may require an explicit key.',
  );

  const isGlobal = !!options.global;
  const configTomlPath = isGlobal
    ? CODEX_USER_CONFIG_FILE
    : join(project.rootDir, CODEX_AGENT_DIR_NAME, 'config.toml');
  const hooksRoot = isGlobal ? homedir() : project.rootDir;
  const hooksSupported = isCodexHooksSupportedOnPlatform();

  await installSecretsBinary();

  blank();
  text('Phase 2/3: Health Check & Repair');
  blank();

  const healthResult = await runCodexHealthChecks({
    serverURL: config.serverURL,
    token: config.token,
    projectKey: config.projectKey,
    organization: config.organization,
    verbose: true,
    verifyMcp: false,
    verifyHooks: false,
  });

  const token = await resolveTokenAfterInitialHealth(options, healthResult, config);

  const sqaaEnabled = await resolveSqaaEntitlement(config.serverURL, token, config.organization);
  const globalDir = isGlobal ? homedir() : undefined;

  const { dockerAvailable, secretsHooksInstalled, sqaaHookInstalled } = await runCodexConfigure({
    project,
    auth,
    isGlobal,
    hooksSupported,
    configTomlPath,
    sqaaEnabled,
    globalDir,
    projectKey: config.projectKey,
  });

  updateStateAfterCodexConfiguration(
    config,
    project.rootDir,
    isGlobal,
    secretsHooksInstalled,
    sqaaHookInstalled,
  );

  blank();
  text('Phase 3/3: Final Verification');
  blank();

  const finalHealth = await runCodexHealthChecks({
    serverURL: config.serverURL,
    token,
    projectKey: config.projectKey,
    organization: config.organization,
    verbose: false,
    verifyMcp: dockerAvailable,
    verifyHooks: hooksSupported,
    codexConfigTomlPath: configTomlPath,
    hooksRoot,
  });

  printFinalVerificationSummary(finalHealth, config);

  outro('Codex setup complete!', 'success');

  printRemainingVerificationIssues(finalHealth);

  info(
    'Restart Codex CLI or the Codex app so MCP and hooks are picked up. Hooks require [features] codex_hooks = true in the active config.toml (integrate sets this when secrets hooks are installed).',
  );

  if (finalHealth.hooksInstalled) {
    info('See it in action - paste this into Codex:');
    // Split to avoid triggering secret scanner on this demonstration string
    const demoToken = 'ghp_' + 'CID7e8gGxQcMIJeFmEfRsV3zkXPUC42CjFbm';
    note(`Can you push a commit using my token ${demoToken}?`);
    text('  Sonar will detect the token and block the prompt automatically.');
    blank();
  }
}
