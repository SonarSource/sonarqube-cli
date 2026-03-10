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

import {
  generateTokenViaBrowser,
  getToken as getKeystoreToken,
} from '../../../cli/commands/_common/token';
import { saveToken } from '../../../lib/keychain';
import { discoverOrganization, discoverServer } from '../_common/discovery';
import {
  addOrUpdateConnection,
  generateConnectionId,
  loadState,
  saveState,
} from '../../../lib/state-manager';
import { discreetSuccess, print, selectPrompt, success, textPrompt } from '../../../ui';
import { SONARCLOUD_HOSTNAME, SONARCLOUD_URL } from '../../../lib/config-constants';
import { SonarQubeClient } from '../../../sonarqube/client';
import { InvalidOptionError } from '../_common/error';

/**
 * Login command - authenticate and save token with organization
 */
export async function authLogin(options: AuthLoginOptions): Promise<void> {
  const server = await validateLoginOptions(options);

  const isCloud = isSonarCloud(server);
  const region = (options.region || 'eu') as 'eu' | 'us';
  const isNonInteractive = !!options.withToken;

  const token = await getOrGenerateToken(server, options.org, isNonInteractive, options.withToken);

  let org = options.org;

  if (isCloud) {
    const client = new SonarQubeClient(server, token);
    org = await validateOrSelectOrganization(client, org, isNonInteractive);
  } else {
    org = await setupOnPremiseOrganization(org);
  }

  await saveToken(server, token, org);

  const state = loadState();
  const keystoreKey = generateConnectionId(server, org);

  const connection = addOrUpdateConnection(state, server, isCloud ? 'cloud' : 'on-premise', {
    orgKey: org,
    region: isCloud ? region : undefined,
    keystoreKey,
  });

  // Fetch server-side IDs for telemetry enrichment (best effort, non-blocking on error).
  const actualToken = token || (await getKeystoreToken(server, org));
  if (actualToken) {
    const apiClient = new SonarQubeClient(server, actualToken);
    connection.userUuid = (await apiClient.getCurrentUser())?.id ?? null;
    if (isCloud && org) {
      connection.organizationUuidV4 = await apiClient.getOrganizationId(org);
    } else if (!isCloud) {
      const status = await apiClient.getSystemStatus();
      connection.sqsInstallationId = status.id ?? null;
    }
  }

  saveState(state);

  const displayServer = isSonarCloud(server) ? `${server} (${org})` : server;
  success(`Authentication successful for: ${displayServer}`);
}

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
  isNonInteractive: boolean,
  withToken: string | undefined,
): Promise<string> {
  if (isNonInteractive) {
    return withToken || '';
  }

  const existingToken = await getKeystoreToken(server, org);
  if (existingToken) {
    const displayServer = isSonarCloud(server) ? `${server} (${org})` : server;
    print(`Token already exists for: ${displayServer}`);
    print('You are already authenticated');
    return existingToken;
  }

  print(`\nAuthenticating with: ${server}`);
  const token = await generateTokenViaBrowser(server);
  discreetSuccess('Token received');
  return token;
}

async function getUserSelectedOrganization(
  client: SonarQubeClient,
  isNonInteractive: boolean,
): Promise<string> {
  // Deduce organization from API: if user is member of exactly one org, use it
  const { organizations: memberOrgs, total: orgTotal } = await client.listUserOrganizations();
  if (memberOrgs.length === 1 && orgTotal === 1) {
    const singleOrg = memberOrgs[0].key;
    print(`Using organization (only member): ${singleOrg}`);
    return singleOrg;
  }

  if (isNonInteractive) {
    throw new Error('Organization must be specified with -o/--org in non-interactive mode');
  }

  // No org memberships — prompt for manual entry
  if (memberOrgs.length === 0) {
    const manualOrg = await textPrompt('Enter organization key');
    if (manualOrg === null) {
      throw new Error('Organization selection cancelled');
    }
    if (!manualOrg.trim()) {
      throw new Error('Organization key is required');
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
    throw new Error('Organization selection cancelled');
  }

  if (choice === MANUAL_ENTRY) {
    const manualOrg = await textPrompt('Enter organization key');
    if (manualOrg === null) {
      throw new Error('Organization selection cancelled');
    }
    if (!manualOrg.trim()) {
      throw new Error('Organization key is required');
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
  isNonInteractive: boolean,
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
  const configOrg = await discoverOrganization();
  if (configOrg) {
    print(`Using organization from config: ${configOrg}`);
    return configOrg;
  }

  return await getUserSelectedOrganization(client, isNonInteractive);
}

async function validateLoginOptions(options: {
  server?: string;
  org?: string;
  withToken?: string;
  region?: string;
}) {
  if (options.org !== undefined && !options.org.trim()) {
    throw new InvalidOptionError(
      '--org value cannot be empty. Provide a valid organization key (e.g., --org my-org)',
    );
  }

  if (options.withToken !== undefined && !options.withToken.trim()) {
    throw new InvalidOptionError(
      '--with-token value cannot be empty. Provide a valid token or omit the flag for browser authentication',
    );
  }

  if (options.server !== undefined && !options.server.trim()) {
    throw new InvalidOptionError(
      '--server value cannot be empty. Provide a valid URL (e.g., https://sonarcloud.io)',
    );
  }

  let server = options.server;
  if (!server) {
    const configServer = await discoverServer();
    server = configServer || SONARCLOUD_URL;
  }

  if (options.server !== undefined) {
    try {
      new URL(server);
    } catch {
      throw new InvalidOptionError(
        `Invalid server URL: '${server}'. Provide a valid URL (e.g., https://sonarcloud.io)`,
      );
    }
  }
  return server;
}

export interface AuthLoginOptions {
  server?: string;
  org?: string;
  withToken?: string;
  region?: string;
}
