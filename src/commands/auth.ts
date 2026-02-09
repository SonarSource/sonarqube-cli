// Authentication command - manage tokens and credentials

import { generateTokenViaBrowser, getToken, saveToken, deleteToken } from '../bootstrap/auth.js';
import { getAllCredentials, purgeAllTokens } from '../lib/keychain.js';
import { SonarQubeClient } from '../sonarqube/client.js';

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
 * Login command - authenticate and save token with organization
 */
export async function authLoginCommand(options: {
  server?: string;
  org?: string;
  withToken?: string;
}): Promise<void> {
  try {
    const server = options.server || SONARCLOUD_URL;
    let org = options.org;
    let token = '';

    // Determine if non-interactive mode
    const isNonInteractive = !!options.withToken;

    // Get or validate token
    if (isNonInteractive) {
      // Non-interactive: use provided token directly
      token = options.withToken!;
    } else {
      // Interactive: check if token already exists
      const existingToken = await getToken(server, org);
      if (existingToken) {
        const displayServer = isSonarCloud(server) ? `${server} (${org})` : server;
        console.log(`✓ Token already exists for: ${displayServer}`);
        console.log('You are already authenticated');
        return;
      }

      // Open browser to get token
      console.log(`\nAuthenticating with: ${server}`);
      token = await generateTokenViaBrowser(server);
      console.log('✓ Token received');
    }

    // If SonarCloud, validate/determine organization
    if (isSonarCloud(server)) {
      const client = new SonarQubeClient(server, token);

      // If org is already specified, verify it exists
      if (org) {
        const orgExists = await client.checkOrganization(org);
        if (!orgExists) {
          console.error(`Error: Organization "${org}" not found or not accessible`);
          process.exit(1);
        }
        console.log(`✓ Using organization: ${org}`);
      } else {
        // Get list of organizations
        const organizations = await client.getOrganizations();

        if (organizations.length === 0) {
          console.error('Error: No organizations found. Check your token.');
          process.exit(1);
        }

        if (organizations.length === 1) {
          // Only one organization, use it automatically
          org = organizations[0].key;
          console.log(`✓ Using organization: ${org} (${organizations[0].name})`);
        } else {
          // Multiple organizations - ask user (only in interactive mode)
          if (isNonInteractive) {
            console.error('Error: Multiple organizations found. Please specify with -o/--org');
            console.log('Available organizations:');
            organizations.forEach((o) => {
              console.log(`  - ${o.key} (${o.name})`);
            });
            process.exit(1);
          }

          console.log('\nYour organizations:');
          organizations.forEach((o, i) => {
            console.log(`  ${i + 1}) ${o.key} (${o.name})`);
          });
          console.log('');

          const choice = await getUserInput('Select organization (number): ');
          const index = parseInt(choice) - 1;

          if (index < 0 || index >= organizations.length) {
            console.error('Error: Invalid organization selection');
            process.exit(1);
          }

          org = organizations[index].key;
          console.log(`✓ Selected organization: ${org}`);
        }
      }

      // Warn about potential 403 errors
      console.log('');
      console.log('⚠️  Note: If the organization is incorrect, you may get 403');
      console.log('   Unauthorized errors in later requests. Logout and login again if needed.');
    }

    // Save token
    await saveToken(server, token, org);

    const displayServer = isSonarCloud(server) ? `${server} (${org})` : server;
    console.log(`✓ Authentication successful for: ${displayServer}`);
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

    const token = await getToken(server);
    if (!token) {
      const displayServer = isSonarCloud(server) ? `${server} (${org})` : server;
      console.log(`ℹ No token found for: ${displayServer}`);
      return;
    }

    await deleteToken(server, org);
    const displayServer = isSonarCloud(server) ? `${server} (${org})` : server;
    console.log(`✓ Logged out from: ${displayServer}`);
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
      return;
    }

    console.log(`Found ${credentials.length} token(s):`);
    credentials.forEach((cred) => {
      console.log(`  - ${cred.account}`);
    });
    console.log('');

    const confirm = await getUserInput('Remove all tokens? (y/n): ');
    if (confirm.toLowerCase() !== 'y') {
      console.log('Cancelled');
      return;
    }

    await purgeAllTokens();
    console.log('✓ All tokens have been removed from keychain');
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
      resolve(input);
    });
  });
}
