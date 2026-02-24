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

import { discoverProject, type ProjectInfo } from '../bootstrap/discovery.js';
import { runHealthChecks } from '../bootstrap/health.js';
import { runRepair } from '../bootstrap/repair.js';
// Config is read from sonar-project.properties, no need to save separate file
import { getToken } from '../bootstrap/auth.js';
import { getAllCredentials } from '../lib/keychain.js';
import { installSecretScanningHooks } from '../bootstrap/hooks.js';
import { loadState, saveState, markAgentConfigured, addInstalledHook } from '../lib/state-manager.js';
import { runCommand } from '../lib/run-command.js';
import { VERSION } from '../version.js';
import logger from '../lib/logger.js';
import { SONARCLOUD_URL, SONARCLOUD_HOSTNAME } from '../lib/config-constants.js';
import { ENV_TOKEN, ENV_SERVER } from '../lib/auth-resolver.js';
import { text, blank, info, success, warn, intro, outro } from '../ui/index.js';

export interface OnboardAgentOptions {
  server?: string;
  project?: string;
  token?: string;
  org?: string;
  nonInteractive?: boolean;
  skipHooks?: boolean;
}

interface ConfigurationData {
  serverURL: string | undefined;
  projectKey: string | undefined;
  organization: string | undefined;
  token: string | undefined;
}

/**
 * Validate that agent is supported
 */
function validateAgent(agent: string): string {
  if (agent !== 'claude') {
    throw new Error(
      `Agent "${agent}" is not yet supported.\nCurrently supported agents: claude\nComing soon: gemini, codex`
    );
  }

  const agentNames: Record<string, string> = {
    'claude': 'Claude Code',
    'gemini': 'Gemini',
    'codex': 'Codex'
  };

  return agentNames[agent] ?? 'Unknown Agent';
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
async function tryGetTokenForServerOrg(serverURL: string | undefined, organization: string | undefined): Promise<string | undefined> {
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
 * Try to get token from SonarCloud credentials in keychain
 */
async function tryGetSonarCloudToken(): Promise<{ token?: string; org?: string }> {
  const credentials = await getAllCredentials();
  const sonarCloudCreds = credentials.filter(cred =>
    cred.account.startsWith(`${SONARCLOUD_HOSTNAME}:`)
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
 * Apply SonarCloud credentials from keychain result
 */
function applySonarCloudCredentials(config: ConfigurationData, scResult: { token?: string; org?: string }): void {
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
async function loadConfiguration(projectInfo: ProjectInfo, options: OnboardAgentOptions): Promise<ConfigurationData> {
  const config: ConfigurationData = {
    serverURL: options.server,
    projectKey: options.project,
    organization: options.org,
    token: options.token
  };

  // Apply env var credentials (CLI options already set above take precedence via ??=)
  const envToken = process.env[ENV_TOKEN];
  const envServer = process.env[ENV_SERVER];

  if (envToken && envServer) {
    config.token ??= envToken;
    config.serverURL ??= envServer;
  } else if (envToken || envServer) {
    const missing = envToken ? ENV_SERVER : ENV_TOKEN;
    warn(`${missing} is not set. Both ${ENV_TOKEN} and ${ENV_SERVER} are required for environment variable authentication. Falling back to saved credentials.`);
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

  // If organization is provided but no server URL, default to SonarCloud
  if (config.organization && !config.serverURL) {
    config.serverURL = SONARCLOUD_URL;
    info('Organization provided, defaulting to SonarCloud');
  }

  return config;
}

/**
 * Validate and print configuration
 */
function validateAndPrintConfiguration(config: ConfigurationData): { serverURL: string; projectKey: string } {
  if (!config.serverURL) {
    throw new Error('Server URL is required. Use --server flag or --org flag for SonarCloud');
  }

  if (!config.projectKey) {
    throw new Error('Project key is required. Use --project flag');
  }

  text(`\nServer: ${config.serverURL}`);
  text(`Project: ${config.projectKey}`);
  if (config.organization) {
    text(`Organization: ${config.organization}`);
  }

  return { serverURL: config.serverURL, projectKey: config.projectKey };
}

/**
 * Ensure token is available, get from keychain or print warning
 */
async function ensureToken(token: string | undefined, serverURL: string, organization: string | undefined): Promise<string | undefined> {
  if (!token) {
    const storedToken = await getToken(serverURL, organization);
    token = storedToken ?? undefined;
  }

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
  projectKey: string,
  projectInfo: ProjectInfo,
  token: string | undefined,
  organization: string | undefined,
  skipHooks: boolean | undefined,
): Promise<string | undefined> {
  text('\nPhase 2/3: Health Check & Repair');
  blank();

  if (!token) {
    text('Skipping health check (no token available)');
    return undefined;
  }

  const healthResult = await runHealthChecks(serverURL, token, projectKey, projectInfo.root, organization);

  if (healthResult.errors.length === 0) {
    success('All checks passed! Configuration is healthy.');
    if (!skipHooks) {
      await installSecretScanningHooks(projectInfo.root);
    }
    return token;
  }

  warn(`Found ${healthResult.errors.length} issue(s):`);
  for (const msg of healthResult.errors) {
    text(`  - ${msg}`);
  }

  // Repair (part of Phase 2)
  text('\n  Running repair...');

  await runRepair(
    serverURL,
    projectInfo.root,
    healthResult,
    projectKey,
    organization,
  );

  return token;
}

/**
 * Run repair without token
 */
async function runRepairWithoutToken(
  serverURL: string,
  projectKey: string,
  projectInfo: ProjectInfo,
  organization: string | undefined,
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
      errors: []
    },
    projectKey,
    organization,
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
function printFinalVerificationResults(finalHealth: Awaited<ReturnType<typeof runHealthChecks>>): void {
  if (finalHealth.tokenValid) text('Token valid');
  if (finalHealth.serverAvailable) text('Server available');
  if (finalHealth.projectAccessible) text('Project accessible');
  if (finalHealth.organizationAccessible) text('Organization accessible');
  if (finalHealth.qualityProfilesAccessible) text('Quality profiles accessible');
  if (finalHealth.hooksInstalled) text('Hooks installed');

  outro('Setup complete!', 'success');

  if (finalHealth.errors.length > 0) {
    warn('Some issues remain:');
    for (const msg of finalHealth.errors) {
      text(`  - ${msg}`);
    }
  }
}

/**
 * Update state after successful configuration
 */
async function updateStateAfterConfiguration(
  hooksInstalled: boolean,
): Promise<void> {
  try {
    const state = loadState(VERSION);

    // Mark agent as configured
    markAgentConfigured(state, 'claude-code', VERSION);

    // Track installed hooks
    if (hooksInstalled) {
      addInstalledHook(state, 'claude-code', 'sonar-secrets', 'PreToolUse');
    }

    saveState(state);
  } catch (err) {
    warn(`Failed to update configuration state: ${(err as Error).message}`);
    logger.warn(`Failed to update configuration state: ${(err as Error).message}`);
    // Don't fail the whole setup if state update fails
  }
}

/**
 * Onboard-agent command handler
 */
export async function integrateCommand(agent: string, options: OnboardAgentOptions): Promise<void> {
  await runCommand(async () => {

  // Validate agent
  const agentName = validateAgent(agent);

  intro(`SonarQube Integration Setup for ${agentName}`);

  // Phase 1: Discovery & Validation
  text('\nPhase 1/3: Discovery & Validation');
  blank();

  const projectInfo = await discoverProject(process.cwd());

  text(`Project root: ${projectInfo.root}`);
  if (projectInfo.isGitRepo) {
    text('Git repository detected');
  }

  // Load configuration from all sources
  const config = await loadConfiguration(projectInfo, options);

  // Validate and extract required values
  const { serverURL, projectKey } = validateAndPrintConfiguration(config);

  // Ensure token is available
  let token = await ensureToken(config.token, serverURL, config.organization);

  // Phase 2 & 3: Health Check and Repair
  if (token) {
    token = await runHealthCheckAndRepair(
      serverURL,
      projectKey,
      projectInfo,
      token,
      config.organization,
      options.skipHooks,
    );

    if (token) {
      // Health check passed, skip to final verification
      text('\nPhase 3/3: Final Verification');
      blank();

      const finalHealth = await runHealthChecks(serverURL, token, projectKey, projectInfo.root, config.organization, false);
      printFinalVerificationResults(finalHealth);

      // Update state with configuration
      await updateStateAfterConfiguration(!options.skipHooks);

      return;
    }
  }

  // If no token, run repair to generate one
  if (!token) {
    token = await runRepairWithoutToken(
      serverURL,
      projectKey,
      projectInfo,
      config.organization,
    );
  }

  // Phase 3: Final Verification
  text('\nPhase 3/3: Final Verification');
  blank();

  const finalHealth = await runHealthChecks(serverURL, token, projectKey, projectInfo.root, config.organization, false);
  printFinalVerificationResults(finalHealth);

  // Update state with configuration
  await updateStateAfterConfiguration(!options.skipHooks);
  });
}
