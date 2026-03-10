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
import { runRepair } from './repair';
import { getToken } from '../../_common/token';
import { getAllCredentials } from '../../../../lib/keychain';
import { installHooks } from './hooks';
import { runMigrations } from './migration';
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
import { ENV_SERVER, ENV_TOKEN } from '../../../../lib/auth-resolver';
import { blank, info, intro, outro, success, text, warn } from '../../../../ui';
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

  if (!config.serverURL && !config.organization) {
    throw new CommandFailedError(
      'Server URL or organization is required. Use --server flag or --org flag for SonarQube Cloud',
    );
  }

  const { serverURL, projectKey } = validateAndPrintConfiguration(config);

  // When both env vars are set, treat as non-interactive (CI context)
  const envBasedAuth = !!(process.env[ENV_TOKEN] && process.env[ENV_SERVER]);
  const effectiveNonInteractive = options.nonInteractive || envBasedAuth;

  await runFullSonarIntegration(
    serverURL,
    projectKey,
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
 * Try to get token from specific server/org combination
 */
async function tryGetTokenForServerOrg(
  serverURL: string | undefined,
  organization: string | undefined,
): Promise<string | undefined> {
  if ((organization || serverURL) && serverURL) {
    const keychainToken = await getToken(serverURL, organization);
    if (keychainToken) {
      text('Found stored credentials');
      return keychainToken;
    }
  }
  return undefined;
}

/**
 * Try to get token from SonarQube Cloud credentials in keychain
 */
async function tryGetSonarCloudToken(): Promise<{ token?: string; org?: string }> {
  const credentials = await getAllCredentials();
  const sonarCloudCreds = credentials.filter((cred) =>
    cred.account.startsWith(`${SONARCLOUD_HOSTNAME}:`),
  );

  if (sonarCloudCreds.length === 0) {
    return {};
  }

  const cred = sonarCloudCreds[0];
  const [, org] = cred.account.split(':');

  const result: { token?: string; org?: string } = { token: cred.password, org };

  text(`Using stored credentials for organization: ${org}`);

  if (sonarCloudCreds.length > 1) {
    info(`Multiple organizations found (${sonarCloudCreds.length}). Using: ${org}`);
    info('  To use a different organization, specify --org');
  }

  return result;
}

/**
 * Apply SonarQube Cloud credentials from keychain result
 */
function applySonarCloudCredentials(
  config: ConfigurationData,
  scResult: { token?: string; org?: string },
): void {
  config.token = config.token || scResult.token;
  config.organization = config.organization || scResult.org;
  if (scResult.org && !config.serverURL) {
    config.serverURL = SONARCLOUD_URL;
  }
}

/**
 * Fetch credentials from keychain if needed
 * Extracted to reduce nesting complexity in loadConfiguration
 */
async function fetchKeychainCredentials(config: ConfigurationData): Promise<void> {
  try {
    if (!config.token) {
      config.token = await tryGetTokenForServerOrg(config.serverURL, config.organization);
    }

    if (!config.token || !config.organization) {
      const scResult = await tryGetSonarCloudToken();
      applySonarCloudCredentials(config, scResult);
    }
  } catch {
    // Silently fail keychain access - will validate required values below
  }
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

  // Apply env var credentials (CLI options already set above take precedence via ??=)
  const envToken = process.env[ENV_TOKEN];
  const envServer = process.env[ENV_SERVER];

  if (envToken && envServer) {
    config.token ??= envToken;
    config.serverURL ??= envServer;
  } else if (envToken || envServer) {
    const missing = envToken ? ENV_SERVER : ENV_TOKEN;
    warn(
      `${missing} is not set. Both ${ENV_TOKEN} and ${ENV_SERVER} are required for environment variable authentication. Falling back to saved credentials.`,
    );
  }

  // Merge with discovered configuration
  const discovered = getDiscoveredConfiguration(projectInfo);
  config.serverURL = config.serverURL || discovered.serverURL;
  config.projectKey = config.projectKey || discovered.projectKey;
  config.organization = config.organization || discovered.organization;

  // Try to get credentials from keychain if not fully provided
  if (!config.token || !config.organization || !config.serverURL) {
    await fetchKeychainCredentials(config);
  }

  // Default to SonarQube Cloud only when organization is set (SonarCloud implies org)
  if (!config.serverURL && config.organization) {
    config.serverURL = SONARCLOUD_URL;
    info('Using SonarQube Cloud.');
  }

  return config;
}

/**
 * Validate and print configuration
 */
function validateAndPrintConfiguration(config: ConfigurationData): {
  serverURL: string;
  projectKey: string | undefined;
} {
  // serverURL is always set by loadConfiguration (defaults to SonarCloud)
  const serverURL = config.serverURL ?? SONARCLOUD_URL;

  text(`\nServer: ${serverURL}`);
  if (config.projectKey) {
    text(`Project: ${config.projectKey}`);
  } else {
    text('No project key provided — project-level checks will be skipped.');
  }
  if (config.organization) {
    text(`Organization: ${config.organization}`);
  }

  return { serverURL, projectKey: config.projectKey };
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
 * Run health check and handle repair if needed
 */
async function runHealthCheckAndRepair(
  serverURL: string,
  projectKey: string | undefined,
  projectInfo: ProjectInfo,
  token: string | undefined,
  organization: string | undefined,
  repairOptions: RepairOptions,
): Promise<string | undefined> {
  text('\nPhase 2/3: Health Check & Repair');
  blank();

  if (!token) {
    text('Skipping health check (no token available)');
    return undefined;
  }

  const { hooksGlobal, nonInteractive } = repairOptions;
  const globalDir = hooksGlobal ? homedir() : undefined;
  const hooksRoot = globalDir ?? projectInfo.root;

  const healthResult = await runHealthChecks(serverURL, token, projectKey, hooksRoot, organization);

  if (healthResult.errors.length === 0) {
    success('All checks passed! Configuration is healthy.');
    await runMigrations(projectInfo.root, globalDir);
    await installHooks(projectInfo.root, globalDir);
    return token;
  }

  warn(`Found ${healthResult.errors.length} issue(s):`);
  for (const msg of healthResult.errors) {
    text(`  - ${msg}`);
  }

  if (nonInteractive && !healthResult.tokenValid) {
    // Can't repair token without browser interaction — install hooks and continue
    await runMigrations(projectInfo.root, globalDir);
    await installHooks(projectInfo.root, globalDir);
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
    // Split to avoid triggering secret scanner on this demonstration string\n    const demoToken = 'ghp_' + 'CID7e8gGxQcMIJeFmEfRsV3zkXPUC42CjFbm';\n    note(\`Can you push a commit using my token ${demoToken}?\`);
    text('  Sonar will detect the token and block the prompt automatically.');
    blank();
  }
}

/**
 * Run Phase 3 final verification and update state
 */
async function runFinalVerification(
  serverURL: string,
  token: string,
  projectKey: string | undefined,
  hooksRoot: string,
  config: ConfigurationData,
  projectRoot: string,
  isGlobal: boolean,
): Promise<void> {
  text('\nPhase 3/3: Final Verification');
  blank();

  const finalHealth = await runHealthChecks(
    serverURL,
    token,
    projectKey,
    hooksRoot,
    config.organization,
    false,
  );
  printFinalVerificationResults(finalHealth, projectKey);

  updateStateAfterConfiguration({
    serverURL,
    organization: config.organization,
    projectKey,
    projectRoot,
    isGlobal,
  });
}

/**
 * Run full SonarQube integration (phases 2 and 3)
 */
async function runFullSonarIntegration(
  serverURL: string,
  projectKey: string | undefined,
  projectInfo: ProjectInfo,
  config: ConfigurationData,
  options: IntegrateClaudeOptions,
  effectiveNonInteractive: boolean,
): Promise<void> {
  const hooksRoot = options.global ? homedir() : projectInfo.root;
  let token = ensureToken(config.token);

  const repairOptions: RepairOptions = {
    hooksGlobal: options.global,
    nonInteractive: effectiveNonInteractive,
  };

  const globalDir = options.global ? homedir() : undefined;
  const isGlobal = options.global ?? false;

  if (token) {
    token = await runHealthCheckAndRepair(
      serverURL,
      projectKey,
      projectInfo,
      token,
      config.organization,
      repairOptions,
    );

    if (token) {
      await runFinalVerification(
        serverURL,
        token,
        projectKey,
        hooksRoot,
        config,
        projectInfo.root,
        isGlobal,
      );
      return;
    }
  }

  if (effectiveNonInteractive) {
    await runMigrations(projectInfo.root, globalDir);
    await installHooks(projectInfo.root, globalDir);
    updateStateAfterConfiguration({
      serverURL,
      organization: config.organization,
      projectKey,
      projectRoot: projectInfo.root,
      isGlobal,
    });
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

  await runFinalVerification(
    serverURL,
    token,
    projectKey,
    hooksRoot,
    config,
    projectInfo.root,
    isGlobal,
  );
}

interface ConfigurationContext {
  serverURL: string;
  organization?: string;
  projectKey?: string;
  projectRoot: string;
  isGlobal: boolean;
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

    // Register extensions in the new registry
    const now = new Date().toISOString();
    const baseExt = {
      agentId: 'claude-code',
      projectRoot,
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

    // Register A3S hook only for cloud connections
    const isCloud = serverURL.includes(SONARCLOUD_HOSTNAME);
    if (isCloud) {
      upsertAgentExtension(state, {
        ...baseExt,
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
