/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
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

import { type BrowserAuthResult, generateTokenViaBrowser } from '@/commands/_common/token.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/command-error.ts';
import { SONARCLOUD_URL, SONARCLOUD_US_URL } from '@/core/config-constants.ts';
import { recordConnectionFromAuth } from '@/core/host/auth-connection-recorder.ts';
import { isSonarQubeCloud } from '@/core/host/auth-resolver.ts';
import {
  deleteStaleTokens,
  getToken as getKeystoreToken,
  saveToken,
} from '@/core/host/keychain.ts';
import { cloudRegionFromUrl } from '@/core/host/sonarcloud-region.ts';
import { discoverOrganization, discoverServer } from '@/core/project-info.ts';
import { SonarQubeClient } from '@/core/server/client.ts';
import { addOrUpdateConnection, getActiveConnection } from '@/core/state/state-manager.ts';
import { loadState, saveState } from '@/core/state/state-repository.ts';
import {
  confirmPrompt,
  discreetSuccess,
  print,
  promptUntilValid,
  selectPrompt,
  success,
  textPrompt,
  warn,
} from '@/core/ui';

/**
 * Login command - authenticate and save token with organization
 */
export async function authLogin(options: AuthLoginOptions): Promise<void> {
  validateLoginOptions(options);
  const server = await resolveServer(options);
  await confirmServerTrust(server);

  const isCloud = isSonarQubeCloud(server);

  const { token, tokenName, reusedExistingToken } = await getOrGenerateToken(server, options.org);

  let org = options.org;

  if (isCloud) {
    const client = new SonarQubeClient(server, token);
    org = await validateOrSelectOrganization(client, org);
  } else {
    org = await setupOnPremiseOrganization(org);
  }

  const state = loadState();
  await deleteStaleTokens(state.auth.connections, server, org);

  await saveToken(server, token, org);
  const existingConnection = getActiveConnection(state);
  const existingTokenName =
    existingConnection?.serverUrl === server && existingConnection.orgKey === org
      ? existingConnection.tokenName
      : undefined;
  const connectionTokenName = reusedExistingToken ? existingTokenName : tokenName;

  const actualToken = token || (await getKeystoreToken(server, org));
  if (actualToken) {
    await recordConnectionFromAuth(
      {
        token: actualToken,
        serverUrl: server,
        orgKey: org,
        connectionType: isCloud ? 'cloud' : 'on-premise',
      },
      { tokenName: connectionTokenName, force: true },
    );
  } else {
    addOrUpdateConnection(state, server, isCloud ? 'cloud' : 'on-premise', {
      orgKey: org,
      region: cloudRegionFromUrl(server),
      tokenName: connectionTokenName,
    });
    saveState(state);
  }

  const displayServer = isSonarQubeCloud(server) ? `${server} (${org})` : server;
  success(`Authentication successful for: ${displayServer}`);

  // When org came from config we never ran the org selection prompts, so stdin is still
  // resumed from the token step (for Windows). Pause it so the process can exit.
  if (process.stdin.isTTY) {
    process.stdin.pause();
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

  const configOrg = await discoverOrganization();
  if (configOrg) {
    print(`Using organization from config: ${configOrg}`);
    return configOrg;
  }

  return undefined;
}

/**
 * Get token for authentication
 */
async function getOrGenerateToken(
  server: string,
  org: string | undefined,
): Promise<BrowserAuthResult & { reusedExistingToken: boolean }> {
  const existingToken = await getKeystoreToken(server, org);
  if (existingToken) {
    const displayServer = isSonarQubeCloud(server) ? `${server} (${org})` : server;
    print(`Token already exists for: ${displayServer}`);
    print('You are already authenticated');
    return { token: existingToken, reusedExistingToken: true };
  }

  print(`\nAuthenticating with: ${server}`);
  const authResult = await generateTokenViaBrowser(server);
  discreetSuccess('Token received');
  return { ...authResult, reusedExistingToken: false };
}

async function getUserSelectedOrganization(client: SonarQubeClient): Promise<string> {
  // Deduce organization from API: if user is member of exactly one org, use it
  const { organizations: memberOrgs, total: orgTotal } = await client.listUserOrganizations();
  if (memberOrgs.length === 1 && orgTotal === 1) {
    const singleOrg = memberOrgs[0].key;
    print(`Using organization (only member): ${singleOrg}`);
    return singleOrg;
  }

  // No org memberships — prompt for manual entry
  if (memberOrgs.length === 0) {
    const manualOrg = await textPrompt('Enter organization key');
    if (manualOrg === null) {
      throw new CommandFailedError('Organization selection cancelled');
    }
    if (!manualOrg.trim()) {
      throw new CommandFailedError('Organization key is required.', {
        remediationHint: 'Provide an organization key with -o/--org or enter one when prompted.',
      });
    }
    return manualOrg.trim();
  }

  // Multiple orgs available — let user pick from a list or enter manually
  if (orgTotal > memberOrgs.length) {
    print(
      `Showing first ${memberOrgs.length} of ${orgTotal} organizations. Use manual entry to select a different organization.`,
    );
  }
  const MANUAL_ENTRY = '__manual__';
  const orgOptions = [
    ...memberOrgs.map((org: { key: string; name: string }) => ({
      value: org.key,
      label: `${org.name} (${org.key})`,
    })),
    { value: MANUAL_ENTRY, label: 'Enter organization key manually' },
  ];

  const choice = await selectPrompt<string>('Select an organization', orgOptions);
  if (choice === null) {
    throw new CommandFailedError('Organization selection cancelled');
  }

  if (choice === MANUAL_ENTRY) {
    const manualOrg = await textPrompt('Enter organization key');
    if (!manualOrg?.trim()) {
      throw new CommandFailedError('Organization key is required.', {
        remediationHint: 'Provide an organization key with -o/--org or enter one when prompted.',
      });
    }
    return manualOrg.trim();
  }

  return choice;
}

/**
 * Validate organization or get from list
 */
async function validateOrSelectOrganization(
  client: SonarQubeClient,
  org: string | undefined,
): Promise<string> {
  if (org) {
    const orgExists = await client.checkOrganization(org);
    if (!orgExists) {
      throw new CommandFailedError(`Organization '${org}' not found or not accessible.`, {
        remediationHint:
          "Check the organization key and your access, then rerun 'sonar auth login'.",
      });
    }
    print(`Using organization: ${org}`);
    return org;
  }

  // Try to find organization in project configs first (skip API call)
  const configOrg = await discoverOrganization();
  if (configOrg) {
    print(`Using organization from config: ${configOrg}`);
    return configOrg;
  }

  return await getUserSelectedOrganization(client);
}

export async function confirmServerTrust(server: string): Promise<void> {
  if (isSonarQubeCloud(server)) {
    return;
  }
  warn('Only connect to servers you trust.');
  const confirmed = await confirmPrompt(`Connect to: ${server}?`, true);
  if (!confirmed) {
    throw new CommandFailedError('Login cancelled');
  }
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

async function selectServerFromPrompt(): Promise<string> {
  const serverType = await selectPrompt('Where would you like to connect?', [
    { value: 'cloud', label: 'SonarQube Cloud' },
    { value: 'server', label: 'SonarQube Server (self-hosted)' },
  ]);

  if (serverType === null) {
    throw new CommandFailedError('Server selection cancelled');
  }

  if (serverType === 'cloud') {
    const region = await selectPrompt('Which SonarQube Cloud region?', [
      { value: SONARCLOUD_URL, label: 'EU (sonarcloud.io)' },
      { value: SONARCLOUD_US_URL, label: 'US (sonarqube.us)' },
    ]);
    if (region === null) {
      throw new CommandFailedError('Server selection cancelled');
    }
    return region;
  }

  const url = await promptUntilValid(
    'Enter server URL',
    (v) => !!v.trim() && isValidUrl(v.trim()),
    'Please enter a valid URL (for example https://sonarqube.mycompany.com/sonarqube).',
  );
  if (url === null) {
    throw new CommandFailedError('Server selection cancelled');
  }
  return url.trim();
}

async function resolveServer(options: AuthLoginOptions): Promise<string> {
  if (options.server) {
    return options.server;
  }
  const configServer = await discoverServer();
  if (configServer) {
    return configServer;
  }
  return selectServerFromPrompt();
}

function validateLoginOptions(options: AuthLoginOptions): void {
  if (options.org !== undefined && !options.org.trim()) {
    throw new InvalidOptionError('--org value cannot be empty.', 'Use --org <organization-key>.');
  }

  if (options.server !== undefined && !options.server.trim()) {
    throw new InvalidOptionError(
      '--server value cannot be empty.',
      'Use --server <url> (for example https://sonarcloud.io).',
    );
  }

  if (options.server !== undefined && !isValidUrl(options.server)) {
    throw new InvalidOptionError(
      `Invalid server URL: '${options.server}'.`,
      'Provide a valid URL (for example https://sonarcloud.io).',
    );
  }
}

export interface AuthLoginOptions {
  server?: string;
  org?: string;
}
