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
import { runCommand } from '../lib/run-command.js';
import logger from '../lib/logger.js';
import { warn, success, print, note, textPrompt, confirmPrompt } from '../ui/index.js';
import { green, red, dim } from '../ui/colors.js';
import { VERSION as CLI_VERSION, VERSION } from '../version.js';
import { SONARCLOUD_URL, SONARCLOUD_HOSTNAME } from '../lib/config-constants.js';

/**
 * Check if server is SonarCloud
 */
function isSonarCloud(serverURL: string): boolean {
  try {
    const url = new URL(serverURL);
    return url.hostname === SONARCLOUD_HOSTNAME;
  } catch {
    return false;
  }
}

/**
 * Try to find server URL from project configs
 */
async function findServerInConfigs(): Promise<string | null> {
  try {
    const projectInfo = await discoverProject(process.cwd());

    // Check sonar-project.properties first
    if (projectInfo.sonarPropsData?.hostURL) {
      const url = projectInfo.sonarPropsData.hostURL;
      print(`Found server in sonar-project.properties: ${url}`);
      return url;
    }

    // Check .sonarlint config
    if (projectInfo.sonarLintData?.serverURL) {
      const url = projectInfo.sonarLintData.serverURL;
      print(`Found server in .sonarlint config: ${url}`);
      return url;
    }

    return null;
  } catch (error) {
    logger.debug(`Error finding server in configs: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Handle on-premise server organization setup
 */
async function setupOnPremiseOrganization(org: string | undefined): Promise<string | undefined> {
  if (org) {
    print(`Using organization: ${org}`);
    return org;
  }

  const configOrg = await findOrganizationInConfigs();
  if (configOrg) {
    print(`Using organization from config: ${configOrg}`);
    return configOrg;
  }

  return undefined;
}

/**
 * Try to find organization from project configs
 */
async function findOrganizationInConfigs(): Promise<string | null> {
  try {
    const projectInfo = await discoverProject(process.cwd());

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
    print(`Token already exists for: ${displayServer}`);
    print('You are already authenticated');
    return '';
  }

  print(`\nAuthenticating with: ${server}`);
  const token = await generateTokenViaBrowser(server);
  print('Token received');
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
    print(`Using organization: ${org}`);
    return org;
  }

  // Try to find organization in project configs first (skip API call)
  const configOrg = await findOrganizationInConfigs();
  if (configOrg) {
    print(`Using organization from config: ${configOrg}`);
    return configOrg;
  }

  // If not in config, prompt user
  print('Please specify your organization key or run this command in a project with sonar-project.properties or .sonarlint config.');

  if (isNonInteractive) {
    throw new Error('Organization must be specified with -o/--org in non-interactive mode');
  }

  const selectedOrg = await textPrompt('Enter organization key');
  if (!selectedOrg?.trim()) {
    throw new Error('Organization key is required');
  }

  print(`Using organization: ${selectedOrg.trim()}`);
  return selectedOrg.trim();
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
  await runCommand(async () => {
    if (options.org !== undefined && !options.org.trim()) {
      throw new Error('--org value cannot be empty. Provide a valid organization key (e.g., --org my-org)');
    }

    if (options.withToken !== undefined && !options.withToken.trim()) {
      throw new Error('--with-token value cannot be empty. Provide a valid token or omit the flag for browser authentication');
    }

    if (options.server !== undefined && !options.server.trim()) {
      throw new Error('--server value cannot be empty. Provide a valid URL (e.g., https://sonarcloud.io)');
    }

    let server = options.server;
    if (!server) {
      const configServer = await findServerInConfigs();
      server = configServer || SONARCLOUD_URL;
    }

    if (options.server !== undefined) {
      try {
        new URL(server);
      } catch {
        throw new Error(`Invalid server URL: '${server}'. Provide a valid URL (e.g., https://sonarcloud.io)`);
      }
    }

    const isCloud = isSonarCloud(server);
    const region = (options.region || 'eu') as 'eu' | 'us';
    const isNonInteractive = !!options.withToken;

    const token = await getOrGenerateToken(server, options.org, isNonInteractive, options.withToken);

    let org = options.org;

    if (isCloud) {
      const client = new SonarQubeClient(server, token);
      org = await validateOrSelectOrganization(client, org, isNonInteractive);

      print('');
      warn('If the organization is incorrect, you may get 403 Unauthorized errors in later requests. Logout and login again if needed.');
    } else {
      org = await setupOnPremiseOrganization(org);
    }

    await saveToken(server, token, org);

    const state = loadState(VERSION);
    const keystoreKey = generateConnectionId(server, org);

    addOrUpdateConnection(state, server, isCloud ? 'cloud' : 'on-premise', {
      orgKey: org,
      region: isCloud ? region : undefined,
      keystoreKey,
    });

    saveState(state);

    const displayServer = isSonarCloud(server) ? `${server} (${org})` : server;
    success(`Authentication successful for: ${displayServer}`);
  });
}

/**
 * Logout command - remove token from keychain
 */
export async function authLogoutCommand(options: {
  server?: string;
  org?: string;
}): Promise<void> {
  await runCommand(async () => {
    let server = options.server;
    if (!server) {
      const configServer = await findServerInConfigs();
      server = configServer || SONARCLOUD_URL;
    }
    const org = options.org;

    if (isSonarCloud(server) && !org) {
      throw new Error('Organization key is required for SonarCloud logout');
    }

    const token = await getKeystoreToken(server, org);
    if (!token) {
      const displayServer = isSonarCloud(server) ? `${server} (${org})` : server;
      print(`No token found for: ${displayServer}`);
      return;
    }

    await deleteToken(server, org);

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
    success(`Logged out from: ${displayServerLogout}`);
  });
}

/**
 * Purge command - remove all tokens from keychain
 */
export async function authPurgeCommand(): Promise<void> {
  await runCommand(async () => {
    const credentials = await getAllCredentials();

    if (credentials.length === 0) {
      print('No tokens found in keychain');
      return;
    }

    print(`Found ${credentials.length} token(s):`);
    credentials.forEach((cred) => {
      print(`  - ${cred.account}`);
    });
    print('');

    const confirmed = await confirmPrompt('Remove all tokens?');
    if (!confirmed) {
      print('Cancelled');
      return;
    }

    await purgeAllTokens();

    const state = loadState(CLI_VERSION);
    state.auth.connections = [];
    state.auth.activeConnectionId = undefined;
    state.auth.isAuthenticated = false;
    saveState(state);

    success('All tokens have been removed from keychain');
  });
}

/**
 * List saved authentication connections with token verification
 */
export async function authStatusCommand(): Promise<void> {
  await runCommand(async () => {
    const state = loadState(CLI_VERSION);

    if (state.auth.connections.length === 0) {
      print('No saved connection');
      return;
    }

    const conn = state.auth.connections[0];
    const token = await getKeystoreToken(conn.serverUrl, conn.orgKey);

    const lines = [
      `Server  ${conn.serverUrl}`,
      ...(conn.orgKey ? [`Org     ${conn.orgKey}`] : []),
    ];

    if (token !== null) {
      note(lines, '✓ Connected', { borderColor: green, titleColor: green, contentColor: dim });
    } else {
      note(
        [...lines, '', 'Run "sonar auth login" to restore the token'],
        '✗ Token missing',
        { borderColor: red, titleColor: red, contentColor: dim }
      );
    }
  });
}
