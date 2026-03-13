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

// Config is read from sonar-project.properties, no need to save separate file
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { discoverProject, type ProjectInfo } from '../../_common/discovery';
import { runHealthChecks } from './health';
import {repairToken, runRepair} from './repair';
import { getToken } from '../../_common/token';
import { installHooks } from './hooks';
import { runMigrations } from '../../../../lib/migration';
import { SonarQubeClient } from '../../../../sonarqube/client';
import {
  addInstalledHook,
  addOrUpdateConnection,
  generateConnectionId,
  loadState,
  markAgentConfigured,
  saveState,
  upsertAgentExtension,
} from '../../../../lib/state-manager';
import { version as VERSION } from '../../../../../package.json';
import logger from '../../../../lib/logger';
import { SONARCLOUD_HOSTNAME, SONARCLOUD_URL } from '../../../../lib/config-constants';
import {ENV_SERVER, ENV_TOKEN, resolveAuth} from '../../../../lib/auth-resolver';
import { blank, info, intro, note, outro, success, text, warn } from '../../../../ui';
import { CommandFailedError } from '../../_common/error';

export interface IntegrateClaudeOptions {
  server?: string;
  project?: string;
  token?: string;
  org?: string;
  nonInteractive?: boolean;
  global?: boolean;
}

interface RepairOptions {
  hooksGlobal: boolean | undefined;
  nonInteractive: boolean | undefined;
}

interface ConfigurationData {
  serverURL: string | undefined;
  projectKey: string | undefined;
  organization: string | undefined;
  token: string | undefined;
}

/**
 * Integrate command handler
 */
export async function integrateClaude(options: IntegrateClaudeOptions): Promise<void> {
  intro(`SonarQube Integration Setup for Claude`);

  text('\nPhase 1/3: Discovery & Validation');
  blank();

  const projectInfo = await discoverProject(process.cwd());

  text(`Project root: ${projectInfo.root}`);
  if (projectInfo.isGitRepo) {
    text('Git repository detected');
  }

  const config = await loadConfiguration(projectInfo, options);
  validateAndPrintConfiguration(config);

  // When both env vars are set, treat as non-interactive (CI context)
  const envBasedAuth = !!(process.env[ENV_TOKEN] && process.env[ENV_SERVER]);
  const effectiveNonInteractive = options.nonInteractive || envBasedAuth;

  await runFullSonarIntegration(
    projectInfo,
    config,
    options,
    effectiveNonInteractive,
  );
}

/**
 * Get configuration from discovered project info
 */
function getDiscoveredConfiguration(projectInfo: ProjectInfo): Partial<ConfigurationData> {
  const config: Partial<ConfigurationData> = {};

  if (projectInfo.hasSonarProps && projectInfo.sonarPropsData) {
    config.serverURL = projectInfo.sonarPropsData.hostURL;
    config.projectKey = projectInfo.sonarPropsData.projectKey;
    config.organization = projectInfo.sonarPropsData.organization;
    text('Found sonar-project.properties');
  }

  if (projectInfo.hasSonarLintConfig && projectInfo.sonarLintData) {
    config.serverURL = config.serverURL || projectInfo.sonarLintData.serverURL;
    config.projectKey = config.projectKey || projectInfo.sonarLintData.projectKey;
    config.organization = config.organization || projectInfo.sonarLintData.organization;
    text('Found .sonarlint/connectedMode.json');
  }

  return config;
}

/**
 * Load configuration from all available sources
 */
async function loadConfiguration(
  projectInfo: ProjectInfo,
  options: IntegrateClaudeOptions,
): Promise<ConfigurationData> {
  const config: ConfigurationData = {
    serverURL: options.server,
    projectKey: options.project,
    organization: options.org,
    token: options.token,
  };

  let resolvedAuth;
  try {
    resolvedAuth = await resolveAuth({
      server: config.serverURL,
      org: config.organization,
      token: config.token,
    });
  } catch {
    // ignore error, command will attempt to call `auth login` flow
  }

  const discovered = getDiscoveredConfiguration(projectInfo);

  if (!!resolvedAuth?.serverUrl && !!discovered.serverURL && (resolvedAuth.serverUrl != discovered.serverURL)) {
    warn('Detected a Server URL mismatch between the current project configuration and the auth logged in configuration. If this is not intended please consider running "sonar auth logout" and re-run the integrate command');
  }

  if (!!resolvedAuth?.orgKey && !!discovered.organization && (resolvedAuth.orgKey != discovered.organization)) {
    warn('Detected an organization mismatch between the current project configuration and the auth logged in configuration. If this in not intended please consider providing "-o" option');
  }

  const resolvedProjectKey = config.projectKey || discovered.projectKey;

  if (resolvedAuth) {
    return {
      serverURL: resolvedAuth.serverUrl,
      organization: resolvedAuth.orgKey,
      token: resolvedAuth.token,
      projectKey: resolvedProjectKey,
    }
  } else {
    return {
      serverURL: config.serverURL || discovered.serverURL || SONARCLOUD_URL,
      organization: config.organization || discovered.organization,
      token: undefined,
      projectKey: resolvedProjectKey
    }
  }
}

/**
 * Validate and print configuration
 */
function validateAndPrintConfiguration(config: ConfigurationData): void {
  if (!config.serverURL && !config.organization) {
    throw new CommandFailedError(
      'Server URL or organization is required. Use --server flag or --org flag for SonarQube Cloud',
    );
  }

  blank();
  text(`Server: ${config.serverURL}`);
  if (config.projectKey) {
    text(`Project: ${config.projectKey}`);
  } else {
    text('No project key provided - project-level checks will be skipped.');
  }
  if (config.organization) {
    text(`Organization: ${config.organization}`);
  }
}

/**
 * Warn if token is missing
 */
function ensureToken(token: string | undefined): string | undefined {
  if (!token) {
    warn('No token found. Will generate during repair phase.');
  }

  return token;
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
  if (!organization || !serverURL.includes(SONARCLOUD_HOSTNAME)) return false;
  const client = new SonarQubeClient(serverURL, token);
  return client.hasA3sEntitlement(organization);
}

/**
 * Run health check and handle repair if needed
 */
async function runHealthCheckAndRepair(
  serverURL: string,
  projectKey: string | undefined,
  projectInfo: ProjectInfo,
  token: string | undefined,
  organization: string | undefined,
  repairOptions: RepairOptions,
  a3sEnabled: boolean,
): Promise<string | undefined> {
  blank();
  text('Phase 2/3: Health Check & Repair');
  blank();

  if (!token) {
    text('No token available');
    token = await repairToken(serverURL, organization);
  }

  const { hooksGlobal, nonInteractive } = repairOptions;
  const globalDir = hooksGlobal ? homedir() : undefined;
  const hooksRoot = globalDir ?? projectInfo.root;

  const healthResult = await runHealthChecks(serverURL, token, projectKey, hooksRoot, organization);

  if (healthResult.errors.length === 0) {
    success('All checks passed! Configuration is healthy.');
    await runMigrations(projectInfo.root, globalDir, a3sEnabled, projectKey);
    await installHooks(projectInfo.root, globalDir, a3sEnabled, projectKey);
    return token;
  }

  warn(`Found ${healthResult.errors.length} issue(s):`);
  for (const msg of healthResult.errors) {
    text(`  - ${msg}`);
  }

  if (nonInteractive && !healthResult.tokenValid) {
    // Can't repair token without browser interaction — install hooks and continue
    await runMigrations(projectInfo.root, globalDir, a3sEnabled, projectKey);
    await installHooks(projectInfo.root, globalDir, a3sEnabled, projectKey);
    return token;
  }

  // Repair (part of Phase 2)
  text('\n  Running repair...');

  const repairedToken = await runRepair(
    serverURL,
    projectInfo.root,
    healthResult,
    projectKey,
    organization,
    globalDir,
    a3sEnabled,
  );

  return repairedToken ?? token;
}

/**
 * Run repair without token
 */
async function runRepairWithoutToken(
  serverURL: string,
  projectKey: string | undefined,
  projectInfo: ProjectInfo,
  organization: string | undefined,
  globalDir?: string,
): Promise<string> {
  text('\n  Running repair...');

  await runRepair(
    serverURL,
    projectInfo.root,
    {
      tokenValid: false,
      serverAvailable: false,
      projectAccessible: false,
      organizationAccessible: false,
      qualityProfilesAccessible: false,
      hooksInstalled: false,
      errors: [],
    },
    projectKey,
    organization,
    globalDir,
  );

  const repairedToken = await getToken(serverURL, organization);
  if (!repairedToken) {
    throw new Error('Failed to obtain token');
  }

  return repairedToken;
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
    info('See it in action — paste this into Claude Code:');
    // Split to avoid triggering secret scanner on this demonstration string
    const demoToken = 'ghp_' + 'CID7e8gGxQcMIJeFmEfRsV3zkXPUC42CjFbm';
    note(`Can you push a commit using my token ${demoToken}?`);
    text('  Sonar will detect the token and block the prompt automatically.');
    blank();
  }
}

/**
 * Run Phase 3 final verification and update state
 */
async function runFinalVerification(
  token: string,
  hooksRoot: string,
  context: ConfigurationContext,
): Promise<void> {
  text('\nPhase 3/3: Final Verification');
  blank();

  const finalHealth = await runHealthChecks(
    context.serverURL,
    token,
    context.projectKey,
    hooksRoot,
    context.organization,
    false,
  );
  printFinalVerificationResults(finalHealth, context.projectKey);

  updateStateAfterConfiguration(context);
}

/**
 * Run full SonarQube integration (phases 2 and 3)
 */
async function runFullSonarIntegration(
  projectInfo: ProjectInfo,
  config: ConfigurationData,
  options: IntegrateClaudeOptions,
  effectiveNonInteractive: boolean,
): Promise<void> {
  const serverURL = config.serverURL!;
  const projectKey = config.projectKey;
  const hooksRoot = options.global ? homedir() : projectInfo.root;
  let token = ensureToken(config.token);

  const repairOptions: RepairOptions = {
    hooksGlobal: options.global,
    nonInteractive: effectiveNonInteractive,
  };

  const globalDir = options.global ? homedir() : undefined;
  const isGlobal = options.global ?? false;

  // Check A3S entitlement once — requires cloud connection + eligible && enabled org
  const a3sEnabled = token
    ? await resolveA3sEntitlement(serverURL, token, config.organization)
    : false;

  const context: ConfigurationContext = {
    serverURL,
    organization: config.organization,
    projectKey,
    projectRoot: projectInfo.root,
    isGlobal,
    hasA3s: a3sEnabled,
  };

  token = await runHealthCheckAndRepair(
    serverURL,
    projectKey,
    projectInfo,
    token,
    config.organization,
    repairOptions,
    a3sEnabled,
  );

  if (token) {
    await runFinalVerification(token, hooksRoot, context);
    return;
  }

  if (effectiveNonInteractive) {
    await runMigrations(projectInfo.root, globalDir, a3sEnabled, projectKey);
    await installHooks(projectInfo.root, globalDir, a3sEnabled, projectKey);
    updateStateAfterConfiguration(context);
    outro('Setup complete!', 'success');
    return;
  }

  token = await runRepairWithoutToken(
    serverURL,
    projectKey,
    projectInfo,
    config.organization,
    globalDir,
  );

  await runFinalVerification(token, hooksRoot, context);
}

interface ConfigurationContext {
  serverURL: string;
  organization?: string;
  projectKey?: string;
  projectRoot: string;
  isGlobal: boolean;
  hasA3s: boolean;
}

/**
 * Update state after successful configuration
 */
function updateStateAfterConfiguration(context: ConfigurationContext): void {
  try {
    const state = loadState();

    const { serverURL, organization, projectKey, projectRoot, isGlobal } = context;

    // Mark agent as configured
    markAgentConfigured(state, 'claude-code', VERSION);

    // Track installed hooks (legacy format for backward compat)
    addInstalledHook(state, 'claude-code', 'sonar-secrets', 'PreToolUse');
    addInstalledHook(state, 'claude-code', 'sonar-secrets', 'UserPromptSubmit');

    // Register extensions in the new registry.
    // For global installs, use homedir() as projectRoot so it doesn't collide with project-level entries.
    const now = new Date().toISOString();
    const effectiveRoot = isGlobal ? homedir() : projectRoot;
    const baseExt = {
      agentId: 'claude-code',
      projectRoot: effectiveRoot,
      global: isGlobal,
      projectKey,
      orgKey: organization,
      serverUrl: serverURL,
      updatedByCliVersion: VERSION,
      updatedAt: now,
    };

    upsertAgentExtension(state, {
      ...baseExt,
      id: randomUUID(),
      kind: 'hook',
      name: 'sonar-secrets',
      hookType: 'PreToolUse',
    });
    upsertAgentExtension(state, {
      ...baseExt,
      id: randomUUID(),
      kind: 'hook',
      name: 'sonar-secrets',
      hookType: 'UserPromptSubmit',
    });

    // Register A3S hook only when org has entitlement.
    // A3S is always project-level (never global), regardless of the -g flag.
    const isCloud = serverURL.includes(SONARCLOUD_HOSTNAME);
    if (context.hasA3s) {
      upsertAgentExtension(state, {
        ...baseExt,
        projectRoot,
        global: false,
        id: randomUUID(),
        kind: 'hook',
        name: 'sonar-a3s',
        hookType: 'PostToolUse',
      });
    }

    // Save connection so `sonar auth status` reports the active connection
    const type = isCloud ? 'cloud' : 'on-premise';
    const keystoreKey = generateConnectionId(serverURL, organization);
    addOrUpdateConnection(state, serverURL, type, { orgKey: organization, keystoreKey });

    saveState(state);
  } catch (err) {
    warn(`Failed to update configuration state: ${(err as Error).message}`);
    logger.warn(`Failed to update configuration state: ${(err as Error).message}`);
    // Don't fail the whole setup if state update fails
  }
}
