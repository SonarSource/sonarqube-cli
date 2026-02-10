// Onboard-agent command - setup SonarQube integration for Claude Code

import { discoverProject, type ProjectInfo } from '../bootstrap/discovery.js';
import { runHealthChecks } from '../bootstrap/health.js';
import { runRepair } from '../bootstrap/repair.js';
// Config is read from sonar-project.properties, no need to save separate file
import { getToken } from '../bootstrap/auth.js';
import { getAllCredentials } from '../lib/keychain.js';
import type { HookType } from '../bootstrap/hooks.js';

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
    console.error(`\nError: Agent "${agent}" is not yet supported.`);
    console.error('Currently supported agents: claude');
    console.error('Coming soon: gemini, codex\n');
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
    console.log('✓ Found sonar-project.properties');
  }

  if (projectInfo.hasSonarLintConfig && projectInfo.sonarLintData) {
    config.serverURL = config.serverURL || projectInfo.sonarLintData.serverURL;
    config.projectKey = config.projectKey || projectInfo.sonarLintData.projectKey;
    config.organization = config.organization || projectInfo.sonarLintData.organization;
    console.log('✓ Found .sonarlint/connectedMode.json');
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
      console.log('✓ Found stored credentials');
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

  console.log(`✓ Using stored credentials for organization: ${org}`);

  if (sonarCloudCreds.length > 1) {
    console.log(`ℹ Multiple organizations found (${sonarCloudCreds.length}). Using: ${org}`);
    console.log('  To use a different organization, specify --org');
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
    console.log('✓ Organization provided, defaulting to SonarCloud');
  }

  return config;
}

/**
 * Validate and print configuration
 */
function validateAndPrintConfiguration(config: ConfigurationData): { serverURL: string; projectKey: string } {
  if (!config.serverURL) {
    console.error('\nError: Server URL is required. Use --server flag or --org flag for SonarCloud');
    process.exit(1);
  }

  if (!config.projectKey) {
    console.error('\nError: Project key is required. Use --project flag');
    process.exit(1);
  }

  console.log(`\nServer: ${config.serverURL}`);
  console.log(`Project: ${config.projectKey}`);
  if (config.organization) {
    console.log(`Organization: ${config.organization}`);
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
    console.log('\n⚠️  No token found. Will generate during repair phase.');
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
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Phase 2/4: Health Check');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!token) {
    console.log('⏭️  Skipping health check (no token available)');
    return undefined;
  }

  const healthResult = await runHealthChecks(serverURL, token, projectKey, projectInfo.root, organization);

  if (healthResult.errors.length === 0) {
    console.log('\n✅ All checks passed! Configuration is healthy.');
    return token;
  }

  console.log(`\n⚠️  Found ${healthResult.errors.length} issue(s):`);
  for (const error of healthResult.errors) {
    console.log(`   - ${error}`);
  }

  // Phase 3: Repair
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Phase 3/4: Repair');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

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
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Phase 3/4: Repair');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

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
    console.error('\nError: Failed to obtain token');
    process.exit(1);
  }

  return repairedToken;
}

/**
 * Print final verification results
 */
function printFinalVerificationResults(finalHealth: Awaited<ReturnType<typeof runHealthChecks>>): void {
  if (finalHealth.tokenValid) console.log('✓ Token valid');
  if (finalHealth.serverAvailable) console.log('✓ Server available');
  if (finalHealth.projectAccessible) console.log('✓ Project accessible');
  if (finalHealth.organizationAccessible) console.log('✓ Organization accessible');
  if (finalHealth.qualityProfilesAccessible) console.log('✓ Quality profiles accessible');
  if (finalHealth.hooksInstalled) console.log('✓ Hooks installed');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ Setup complete!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (finalHealth.errors.length > 0) {
    console.log('\n⚠️  Some issues remain:');
    for (const error of finalHealth.errors) {
      console.log(`   - ${error}`);
    }
  }
}

/**
 * Onboard-agent command handler
 */
export async function onboardAgentCommand(agent: string, options: OnboardAgentOptions): Promise<void> {
  const verbose = options.verbose || false;

  // Validate agent
  const agentName = validateAgent(agent);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 SonarQube Integration Setup for ${agentName}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Phase 1: Discovery & Validation
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Phase 1/4: Discovery & Validation');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const projectInfo = await discoverProject(process.cwd(), verbose);

  console.log(`✓ Project root: ${projectInfo.root}`);
  if (projectInfo.isGitRepo) {
    console.log('✓ Git repository detected');
  }

  // Load configuration from all sources
  let config = await loadConfiguration(projectInfo, options);

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
      (options.hookType || 'prompt') as HookType
    );

    if (token) {
      // Health check passed, skip to final verification
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('Phase 4/4: Final Verification');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      const finalHealth = await runHealthChecks(serverURL, token, projectKey, projectInfo.root, config.organization);
      printFinalVerificationResults(finalHealth);
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
      (options.hookType || 'prompt') as HookType
    );
  }

  // Phase 4: Final Verification
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Phase 4/4: Final Verification');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const finalHealth = await runHealthChecks(serverURL, token, projectKey, projectInfo.root, config.organization);
  printFinalVerificationResults(finalHealth);

  process.exit(0);
}
