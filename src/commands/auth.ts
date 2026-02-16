// Authentication command - manage tokens and credentials

import { generateTokenViaBrowser, getToken as getKeystoreToken, saveToken, deleteToken } from '../bootstrap/auth.js';
import { getAllCredentials, purgeAllTokens } from '../lib/keychain.js';
import { discoverProject } from '../bootstrap/discovery.js';
import { SonarQubeClient } from '../sonarqube/client.js';
import {
  loadState,
  saveState,
  addOrUpdateConnection,
  generateConnectionId
} from '../lib/state-manager.js';
import logger from '../lib/logger.js';

import { VERSION as CLI_VERSION, VERSION } from '../version.js';
const SONARCLOUD_URL = 'https://sonarcloud.io';

/**
 * Check if server is SonarCloud
 */
function isSonarCloud(serverURL: string): boolean {
  try {
    const url = new URL(serverURL);
    return url.hostname === 'sonarcloud.io';
  } catch {
    return false;
  }
}

/**
 * Try to find organization from project configs
 */
async function findOrganizationInConfigs(): Promise<string | null> {
  try {
    const projectInfo = await discoverProject(process.cwd(), false);

    // Check sonar-project.properties
    if (projectInfo.sonarPropsData?.organization) {
      return projectInfo.sonarPropsData.organization;
    }

    // Check .sonarlint config
    if (projectInfo.sonarLintData?.organization) {
      return projectInfo.sonarLintData.organization;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get token for authentication
 */
async function getOrGenerateToken(
  server: string,
  org: string | undefined,
  isNonInteractive: boolean,
  withToken: string | undefined
): Promise<string> {
  if (isNonInteractive) {
    return withToken || '';
  }

  const existingToken = await getKeystoreToken(server, org);
  if (existingToken) {
    const displayServer = isSonarCloud(server) ? `${server} (${org})` : server;
    logger.info(`✓ Token already exists for: ${displayServer}`);
    logger.info('You are already authenticated');
    return '';
  }

  logger.info(`\nAuthenticating with: ${server}`);
  const token = await generateTokenViaBrowser(server);
  logger.info('✓ Token received');
  return token;
}

/**
 * Validate organization or get from list
 */
async function validateOrSelectOrganization(
  client: SonarQubeClient,
  org: string | undefined,
  isNonInteractive: boolean
): Promise<string> {
  if (org) {
    const orgExists = await client.checkOrganization(org);
    if (!orgExists) {
      throw new Error(`Organization "${org}" not found or not accessible`);
    }
    logger.info(`✓ Using organization: ${org}`);
    return org;
  }

  // Try to find organization in project configs first (skip API call)
  const configOrg = await findOrganizationInConfigs();
  if (configOrg) {
    logger.info(`✓ Using organization from config: ${configOrg}`);
    return configOrg;
  }

  // If not in config, prompt user
  logger.info('Please specify your organization key or run this command in a project with sonar-project.properties or .sonarlint config.');
  logger.info('');

  if (isNonInteractive) {
    throw new Error('Organization must be specified with -o/--org in non-interactive mode');
  }

  const selectedOrg = await getUserInput('Enter organization key: ');
  if (!selectedOrg.trim()) {
    throw new Error('Organization key is required');
  }

  logger.info(`✓ Using organization: ${selectedOrg.trim()}`);
  return selectedOrg.trim();
}

/**
 * Select organization interactively
 */
async function selectOrganizationInteractive(
  organizations: Array<{ key: string; name: string }>
): Promise<string> {
  logger.info('\nYour organizations:');
  organizations.forEach((o, i) => {
    logger.info(`  ${i + 1}) ${o.key} (${o.name})`);
  });
  logger.info('');

  const choice = await getUserInput('Select organization (number): ');
  const index = Number.parseInt(choice, 10) - 1;

  if (index < 0 || index >= organizations.length) {
    throw new Error('Invalid organization selection');
  }

  const org = organizations[index].key;
  logger.info(`✓ Selected organization: ${org}`);
  return org;
}

/**
 * Login command - authenticate and save token with organization
 */
export async function authLoginCommand(options: {
  server?: string;
  org?: string;
  withToken?: string;
  region?: string;
}): Promise<void> {
  try {
    const server = options.server || SONARCLOUD_URL;
    const region = (options.region || 'eu') as 'eu' | 'us';
    const isNonInteractive = !!options.withToken;

    const token = await getOrGenerateToken(server, options.org, isNonInteractive, options.withToken);

    let org = options.org;
    if (isSonarCloud(server)) {
      const client = new SonarQubeClient(server, token);
      org = await validateOrSelectOrganization(client, org, isNonInteractive);

      logger.info('');
      logger.info('ℹ️   Note: If the organization is incorrect, you may get 403');
      logger.info('   Unauthorized errors in later requests. Logout and login again if needed.');
    }

    // Save token to keychain
    await saveToken(server, token, org);

    // Update state
    const state = loadState(VERSION);
    const isCloud = isSonarCloud(server);
    const keystoreKey = generateConnectionId(server, org);

    addOrUpdateConnection(state, server, isCloud ? 'cloud' : 'on-premise', {
      orgKey: org,
      region: isCloud ? region : undefined,
      keystoreKey,
    });

    saveState(state);

    const displayServer = isSonarCloud(server) ? `${server} (${org})` : server;
    logger.success(`✅ Authentication successful for: ${displayServer}`);
    process.exit(0);
  } catch (error) {
    throw error;
  }
}

/**
 * Logout command - remove token from keychain
 */
export async function authLogoutCommand(options: {
  server?: string;
  org?: string;
}): Promise<void> {
  try {
    const server = options.server || SONARCLOUD_URL;
    const org = options.org;

    if (isSonarCloud(server) && !org) {
      throw new Error('Organization key is required for SonarCloud logout');
    }

    const token = await getKeystoreToken(server, org);
    if (!token) {
      const displayServer = isSonarCloud(server) ? `${server} (${org})` : server;
      logger.info(`ℹ No token found for: ${displayServer}`);
      return;
    }

    await deleteToken(server, org);

    // Update state
    const state = loadState(CLI_VERSION);
    const connectionId = generateConnectionId(server, org);
    state.auth.connections = state.auth.connections.filter((c) => c.id !== connectionId);

    if (state.auth.activeConnectionId === connectionId) {
      state.auth.activeConnectionId = state.auth.connections[0]?.id;
    }

    if (state.auth.connections.length === 0) {
      state.auth.isAuthenticated = false;
    }

    saveState(state);

    const displayServerLogout = isSonarCloud(server) ? `${server} (${org})` : server;
    logger.info(`✓ Logged out from: ${displayServerLogout}`);
  } catch (error) {
    throw error;
  }
}

/**
 * Purge command - remove all tokens from keychain
 */
export async function authPurgeCommand(): Promise<void> {
  try {
    const credentials = await getAllCredentials();

    if (credentials.length === 0) {
      logger.info('ℹ No tokens found in keychain');
      return;
    }

    logger.info(`Found ${credentials.length} token(s):`);
    credentials.forEach((cred) => {
      logger.info(`  - ${cred.account}`);
    });
    logger.info('');

    const confirm = await getUserInput('Remove all tokens? (y/n): ');
    if (confirm.toLowerCase() !== 'y') {
      logger.info('Cancelled');
      return;
    }

    await purgeAllTokens();

    // Update state
    const state = loadState(CLI_VERSION);
    state.auth.connections = [];
    state.auth.activeConnectionId = undefined;
    state.auth.isAuthenticated = false;
    saveState(state);

    logger.success('✓ All tokens have been removed from keychain');
  } catch (error) {
    throw error;
  }
}

/**
 * List saved authentication connections with token verification
 */
export async function authListCommand(): Promise<void> {
  try {
    const state = loadState(CLI_VERSION);

    if (state.auth.connections.length === 0) {
      logger.info('ℹ No saved authentication connections');
      return;
    }

    logger.info(`Found ${state.auth.connections.length} saved connection(s):\n`);

    let validCount = 0;
    let missingCount = 0;

    for (const conn of state.auth.connections) {
      // Check if token exists in keychain
      const token = await getKeystoreToken(conn.serverUrl, conn.orgKey);
      const isValid = token !== null;


      if (isValid) {
        validCount++;
        const checkmark = '✓';
        const orgDisplay = conn.orgKey ? ` (org: ${conn.orgKey})` : '';
        logger.info(`  ${checkmark} ${conn.serverUrl}${orgDisplay}`);
      } else {
        missingCount++;
        const cross = '✗';
        const orgDisplay = conn.orgKey ? ` (org: ${conn.orgKey})` : '';
        logger.info(`  ${cross} ${conn.serverUrl}${orgDisplay} [token missing]`);
      }
    }

    logger.info(`\nSummary: ${validCount} valid, ${missingCount} missing`);

    if (missingCount > 0) {
      logger.info('Run "sonar auth login" to add missing tokens');
    }
  } catch (error) {
    throw error;
  }
}

/**
 * Get user input from stdin
 */
async function getUserInput(prompt: string): Promise<string> {
  process.stdout.write(prompt);

  return new Promise((resolve) => {
    let input = '';

    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', (data) => {
      input = data.toString().trim();
      process.stdin.destroy();
      resolve(input);
    });
  });
}
