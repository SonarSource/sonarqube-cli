// Authentication command - manage tokens and credentials

import { generateTokenViaBrowser, getToken, saveToken, deleteToken } from '../bootstrap/auth.js';
import { getAllCredentials, purgeAllTokens } from '../lib/keychain.js';
import { SonarQubeClient } from '../sonarqube/client.js';
import {
  loadState,
  saveState,
  addOrUpdateConnection,
  generateConnectionId
} from '../lib/state-manager.js';

const SONARCLOUD_URL = 'https://sonarcloud.io';
const CLI_VERSION = '0.2.62';

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

  const existingToken = await getToken(server, org);
  if (existingToken) {
    const displayServer = isSonarCloud(server) ? `${server} (${org})` : server;
    console.log(`✓ Token already exists for: ${displayServer}`);
    console.log('You are already authenticated');
    process.exit(0);
  }

  console.log(`\nAuthenticating with: ${server}`);
  const token = await generateTokenViaBrowser(server);
  console.log('✓ Token received');
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
      console.error(`Error: Organization "${org}" not found or not accessible`);
      process.exit(1);
    }
    console.log(`✓ Using organization: ${org}`);
    return org;
  }

  const organizations = await client.getOrganizations();

  if (organizations.length === 0) {
    console.error('Error: No organizations found.');
    console.error('This could mean:');
    console.error('  - You don\'t have access to any organizations');
    console.error('  - The token has insufficient permissions');
    console.error('  - Try specifying organization explicitly: sonar auth login -o <organization>');
    process.exit(1);
  }

  if (organizations.length === 1) {
    const selectedOrg = organizations[0].key;
    console.log(`✓ Using organization: ${selectedOrg} (${organizations[0].name})`);
    return selectedOrg;
  }

  if (isNonInteractive) {
    console.error('Error: Multiple organizations found. Please specify with -o/--org');
    console.log('Available organizations:');
    organizations.forEach((o) => {
      console.log(`  - ${o.key} (${o.name})`);
    });
    process.exit(1);
  }

  return selectOrganizationInteractive(organizations);
}

/**
 * Select organization interactively
 */
async function selectOrganizationInteractive(
  organizations: Array<{ key: string; name: string }>
): Promise<string> {
  console.log('\nYour organizations:');
  organizations.forEach((o, i) => {
    console.log(`  ${i + 1}) ${o.key} (${o.name})`);
  });
  console.log('');

  const choice = await getUserInput('Select organization (number): ');
  const index = Number.parseInt(choice, 10) - 1;

  if (index < 0 || index >= organizations.length) {
    console.error('Error: Invalid organization selection');
    process.exit(1);
  }

  const org = organizations[index].key;
  console.log(`✓ Selected organization: ${org}`);
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

      console.log('');
      console.log('⚠️  Note: If the organization is incorrect, you may get 403');
      console.log('   Unauthorized errors in later requests. Logout and login again if needed.');
    }

    // Save token to keychain
    await saveToken(server, token, org);

    // Update state
    const state = loadState(CLI_VERSION);
    const isCloud = isSonarCloud(server);
    const keystoreKey = generateConnectionId(server, org);

    addOrUpdateConnection(state, server, isCloud ? 'cloud' : 'on-premise', {
      orgKey: org,
      region: isCloud ? region : undefined,
      keystoreKey,
    });

    saveState(state);

    const displayServer = isSonarCloud(server) ? `${server} (${org})` : server;
    console.log(`✓ Authentication successful for: ${displayServer}`);
    process.exit(0);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
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
      console.error('Error: Organization key is required for SonarCloud logout');
      process.exit(1);
    }

    const token = await getToken(server, org);
    if (!token) {
      const displayServer = isSonarCloud(server) ? `${server} (${org})` : server;
      console.log(`ℹ No token found for: ${displayServer}`);
      process.exit(0);
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

    const displayServer = isSonarCloud(server) ? `${server} (${org})` : server;
    console.log(`✓ Logged out from: ${displayServer}`);
    process.exit(0);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * Purge command - remove all tokens from keychain
 */
export async function authPurgeCommand(): Promise<void> {
  try {
    const credentials = await getAllCredentials();

    if (credentials.length === 0) {
      console.log('ℹ No tokens found in keychain');
      process.exit(0);
    }

    console.log(`Found ${credentials.length} token(s):`);
    credentials.forEach((cred) => {
      console.log(`  - ${cred.account}`);
    });
    console.log('');

    const confirm = await getUserInput('Remove all tokens? (y/n): ');
    if (confirm.toLowerCase() !== 'y') {
      console.log('Cancelled');
      process.exit(0);
    }

    await purgeAllTokens();

    // Update state
    const state = loadState(CLI_VERSION);
    state.auth.connections = [];
    state.auth.activeConnectionId = undefined;
    state.auth.isAuthenticated = false;
    saveState(state);

    console.log('✓ All tokens have been removed from keychain');
    process.exit(0);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
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
