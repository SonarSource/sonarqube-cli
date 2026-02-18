// Onboard-agent command - setup SonarQube integration for Claude Code

import { discoverProject, type ProjectInfo } from '../bootstrap/discovery.js';
import { runHealthChecks } from '../bootstrap/health.js';
import { runRepair } from '../bootstrap/repair.js';
// Config is read from sonar-project.properties, no need to save separate file
import { getToken } from '../bootstrap/auth.js';
import { getAllCredentials } from '../lib/keychain.js';
import type { HookType } from '../bootstrap/hooks.js';
import { loadState, saveState, markAgentConfigured, addInstalledHook } from '../lib/state-manager.js';
import { VERSION } from '../version.js';
import logger from '../lib/logger.js';

export interface OnboardAgentOptions {
  server?: string;
  project?: string;
  token?: string;
  org?: string;
  nonInteractive?: boolean;
  skipHooks?: boolean;
  hookType?: string;
  verbose?: boolean;
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
    logger.error(`\nError: Agent "${agent}" is not yet supported.`);
    logger.error('Currently supported agents: claude');
    logger.error('Coming soon: gemini, codex\n');
    process.exit(1);
  }

  const agentNames: Record<string, string> = {
    'claude': 'Claude Code',
    'gemini': 'Gemini',
    'codex': 'Codex'
  };

  return agentNames[agent] || 'Unknown Agent';
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
    logger.info('✓ Found sonar-project.properties');
  }

  if (projectInfo.hasSonarLintConfig && projectInfo.sonarLintData) {
    config.serverURL = config.serverURL || projectInfo.sonarLintData.serverURL;
    config.projectKey = config.projectKey || projectInfo.sonarLintData.projectKey;
    config.organization = config.organization || projectInfo.sonarLintData.organization;
    logger.info('✓ Found .sonarlint/connectedMode.json');
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
      logger.info('✓ Found stored credentials');
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
    cred.account.startsWith('sonarcloud.io:')
  );

  if (sonarCloudCreds.length === 0) {
    return {};
  }

  const cred = sonarCloudCreds[0];
  const [, org] = cred.account.split(':');

  const result: { token?: string; org?: string } = { token: cred.password, org };

  logger.info(`✓ Using stored credentials for organization: ${org}`);

  if (sonarCloudCreds.length > 1) {
    logger.info(`ℹ Multiple organizations found (${sonarCloudCreds.length}). Using: ${org}`);
    logger.info('  To use a different organization, specify --org');
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
    config.serverURL = 'https://sonarcloud.io';
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
  let config: ConfigurationData = {
    serverURL: options.server,
    projectKey: options.project,
    organization: options.org,
    token: options.token
  };

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
    config.serverURL = 'https://sonarcloud.io';
    logger.info('✓ Organization provided, defaulting to SonarCloud');
  }

  return config;
}

/**
 * Validate and print configuration
 */
function validateAndPrintConfiguration(config: ConfigurationData): { serverURL: string; projectKey: string } {
  if (!config.serverURL) {
    logger.error('\nError: Server URL is required. Use --server flag or --org flag for SonarCloud');
    process.exit(1);
  }

  if (!config.projectKey) {
    logger.error('\nError: Project key is required. Use --project flag');
    process.exit(1);
  }

  logger.info(`\nServer: ${config.serverURL}`);
  logger.info(`Project: ${config.projectKey}`);
  if (config.organization) {
    logger.info(`Organization: ${config.organization}`);
  }

  return { serverURL: config.serverURL, projectKey: config.projectKey };
}

/**
 * Ensure token is available, get from keychain or print warning
 */
async function ensureToken(token: string | undefined, serverURL: string, organization: string | undefined): Promise<string | undefined> {
  if (!token) {
    const storedToken = await getToken(serverURL, organization);
    token = storedToken || undefined;
  }

  if (!token) {
    logger.info('\n⚠️  No token found. Will generate during repair phase.');
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
  hookType: HookType
): Promise<string | undefined> {
  logger.info('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('Phase 2/3: Health Check & Repair');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!token) {
    logger.info('⏭️  Skipping health check (no token available)');
    return undefined;
  }

  const healthResult = await runHealthChecks(serverURL, token, projectKey, projectInfo.root, organization);

  if (healthResult.errors.length === 0) {
    logger.info('\n✅ All checks passed! Configuration is healthy.');
    return token;
  }

  logger.info(`\n⚠️  Found ${healthResult.errors.length} issue(s):`);
  for (const error of healthResult.errors) {
    logger.info(`   - ${error}`);
  }

  // Repair (part of Phase 2)
  logger.info('\n   Running repair...');

  await runRepair(
    serverURL,
    projectInfo.root,
    healthResult,
    projectKey,
    organization,
    skipHooks ? undefined : hookType
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
  skipHooks: boolean | undefined,
  hookType: HookType
): Promise<string> {
  logger.info('\n   Running repair...');

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
    skipHooks ? undefined : hookType
  );

  const repairedToken = await getToken(serverURL, organization);
  if (!repairedToken) {
    logger.error('\nError: Failed to obtain token');
    process.exit(1);
  }

  return repairedToken;
}

/**
 * Print final verification results
 */
function printFinalVerificationResults(finalHealth: Awaited<ReturnType<typeof runHealthChecks>>): void {
  if (finalHealth.tokenValid) logger.info('✓ Token valid');
  if (finalHealth.serverAvailable) logger.info('✓ Server available');
  if (finalHealth.projectAccessible) logger.info('✓ Project accessible');
  if (finalHealth.organizationAccessible) logger.info('✓ Organization accessible');
  if (finalHealth.qualityProfilesAccessible) logger.info('✓ Quality profiles accessible');
  if (finalHealth.hooksInstalled) logger.info('✓ Hooks installed');

  logger.info('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('✅ Setup complete!');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (finalHealth.errors.length > 0) {
    logger.info('\n⚠️  Some issues remain:');
    for (const error of finalHealth.errors) {
      logger.info(`   - ${error}`);
    }
  }
}

/**
 * Update state after successful configuration
 */
async function updateStateAfterConfiguration(
  hooksInstalled: boolean,
  hookType: HookType
): Promise<void> {
  try {
    const state = loadState(VERSION);

    // Mark agent as configured
    markAgentConfigured(state, 'claude-code', VERSION);

    // Track installed hooks
    if (hooksInstalled) {
      addInstalledHook(state, 'claude-code', 'sonar-prompt', hookType === 'cli' ? 'PreToolUse' : 'PostToolUse');
    }

    saveState(state);
  } catch (error) {
    logger.warn('Warning: Failed to update configuration state:', (error as Error).message);
    // Don't fail the whole setup if state update fails
  }
}

/**
 * Onboard-agent command handler
 */
export async function onboardAgentCommand(agent: string, options: OnboardAgentOptions): Promise<void> {
  const verbose = false;

  // Validate agent
  const agentName = validateAgent(agent);

  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info(`🚀 SonarQube Integration Setup for ${agentName}`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Phase 1: Discovery & Validation
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('Phase 1/3: Discovery & Validation');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const projectInfo = await discoverProject(process.cwd(), verbose);

  logger.info(`✓ Project root: ${projectInfo.root}`);
  if (projectInfo.isGitRepo) {
    logger.info('✓ Git repository detected');
  }

  // Load configuration from all sources
  let config = await loadConfiguration(projectInfo, options);

  // Validate and extract required values
  const { serverURL, projectKey } = validateAndPrintConfiguration(config);

  // Ensure token is available
  let token = await ensureToken(config.token, serverURL, config.organization);

  // Phase 2 & 3: Health Check and Repair
  const hookType = (options.hookType || 'prompt') as HookType;
  if (token) {
    token = await runHealthCheckAndRepair(
      serverURL,
      projectKey,
      projectInfo,
      token,
      config.organization,
      options.skipHooks,
      hookType
    );

    if (token) {
      // Health check passed, skip to final verification
      logger.info('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.info('Phase 3/3: Final Verification');
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      const finalHealth = await runHealthChecks(serverURL, token, projectKey, projectInfo.root, config.organization, false);
      printFinalVerificationResults(finalHealth);

      // Update state with configuration
      await updateStateAfterConfiguration(!options.skipHooks, hookType);

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
      options.skipHooks,
      hookType
    );
  }

  // Phase 3: Final Verification
  logger.info('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('Phase 3/3: Final Verification');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const finalHealth = await runHealthChecks(serverURL, token, projectKey, projectInfo.root, config.organization, false);
  printFinalVerificationResults(finalHealth);

  // Update state with configuration
  await updateStateAfterConfiguration(!options.skipHooks, hookType);

  process.exit(0);
}
