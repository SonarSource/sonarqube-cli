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

import { recordConnectionFromAuth } from '@/core/auth/auth-connection-recorder.ts';
import { isSonarQubeCloud } from '@/core/auth/auth-resolver.ts';
import { type BrowserAuthResult, generateTokenViaBrowser } from '@/core/auth/token.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/command-error.ts';
import { SONARCLOUD_URL, SONARCLOUD_US_URL } from '@/core/config-constants.ts';
import {
  deleteStaleTokens,
  getToken as getKeystoreToken,
  saveToken,
} from '@/core/host/keychain.ts';
import { discoverOrganization, discoverServer } from '@/core/project-info.ts';
import {
  type Organization,
  type OrganizationAccess,
  SonarQubeClient,
} from '@/core/server/client.ts';
import { cloudRegionFromUrl } from '@/core/server/sonarcloud-region.ts';
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

import {
  reportRevokeServerTokenOutcome,
  revokeServerTokenIfPossible,
} from './revoke-server-token.ts';

/**
 * Login command - authenticate and save token with organization
 */
export async function authLogin(options: AuthLoginOptions): Promise<void> {
  validateLoginOptions(options);
  const server = await resolveServer(options);
  await confirmServerTrust(server);

  const isCloud = isSonarQubeCloud(server);
  const orgOption = options.org?.trim();

  try {
    const auth = await getOrGenerateToken(server, orgOption);
    const { token, tokenName, reusedExistingToken } = auth;

    const org = await resolveOrganization(server, isCloud, orgOption, auth);

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

    const displayServer = isCloud ? `${server} (${org})` : server;
    success(`Authentication successful for: ${displayServer}`);
  } finally {
    // The token step leaves stdin resumed for Windows keypresses, and a resumed TTY keeps the
    // process alive. Release it on every exit path, not only on success. That step resumes stdin
    // when it fails too (Ctrl+C at the browser prompt), so it has to sit inside the try.
    if (process.stdin.isTTY) {
      process.stdin.pause();
    }
  }
}

/**
 * Resolve the organization.
 *
 * When it is rejected, discard the token this login just minted, so a typo does not leave an
 * unusable token in the user's account.
 */
async function resolveOrganization(
  server: string,
  isCloud: boolean,
  orgOption: string | undefined,
  auth: BrowserAuthResult & { reusedExistingToken: boolean },
): Promise<string | undefined> {
  try {
    return isCloud
      ? await validateOrSelectOrganization(new SonarQubeClient(server, auth.token), orgOption)
      : await setupOnPremiseOrganization(orgOption);
  } catch (error) {
    if (!auth.reusedExistingToken) {
      await discardGeneratedToken(server, auth.token, auth.tokenName);
    }
    throw error;
  }
}

/**
 * Revoke the token this login just minted. Best-effort: failures only warn.
 *
 * The callback that carried the token may not have named it, in which case the CLI cannot revoke
 * it and says so, rather than leaving an unusable token behind without telling anyone.
 */
async function discardGeneratedToken(
  serverUrl: string,
  token: string,
  tokenName: string | undefined,
): Promise<void> {
  const outcome = await revokeServerTokenIfPossible({ serverUrl, tokenName }, token);
  reportRevokeServerTokenOutcome(outcome, {
    continuingMessage: 'Revoke it manually on the server if needed.',
  });
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

/**
 * Turn a rejected lookup into an error.
 *
 * A failed lookup gets its own message, so a network or server problem is never reported as a
 * missing organization.
 */
function organizationAccessError(
  org: string,
  access: Extract<OrganizationAccess, { status: 'not_found' | 'check_failed' }>,
): CommandFailedError {
  if (access.status === 'not_found') {
    return new CommandFailedError(`Organization '${org}' not found or not accessible.`, {
      remediationHint:
        "Check the organization key (keys are lowercase) and your access, then rerun 'sonar auth login'.",
    });
  }

  return new CommandFailedError(`Could not verify organization '${org}': ${access.reason}`, {
    remediationHint:
      "Check your network connection and the server status, then rerun 'sonar auth login'.",
  });
}

/** Fail unless the server can resolve the key. */
async function assertOrganizationAccessible(client: SonarQubeClient, org: string): Promise<void> {
  const access = await client.resolveOrganizationAccess(org);
  if (access.status !== 'accessible') {
    throw organizationAccessError(org, access);
  }
}

function organizationRequiredError(): CommandFailedError {
  return new CommandFailedError('Organization key is required.', {
    remediationHint: 'Provide an organization key with -o/--org or enter one when prompted.',
  });
}

/**
 * How many keys the user may try before the login gives up.
 *
 * A prompt that never yields a usable answer would otherwise loop forever, which turns a stuck
 * terminal — or a test that runs out of queued answers — into a hang instead of an error.
 */
const MAX_ORGANIZATION_ATTEMPTS = 5;

/**
 * Prompt for an organization key until the server resolves one.
 *
 * Nothing typed here should cost the browser flow that just ran, so a typo — or an accidental
 * Enter — is reported and asked again rather than ending the login. Asking again cannot fix an
 * outage, and piped input has nobody to ask, so those still abort on the first rejection.
 */
async function promptForOrganizationKey(client: SonarQubeClient): Promise<string> {
  let lastError = organizationRequiredError();

  for (let attempt = 0; attempt < MAX_ORGANIZATION_ATTEMPTS; attempt++) {
    const manualOrg = await textPrompt('Enter organization key');
    if (manualOrg === null) {
      throw new CommandFailedError('Organization selection cancelled');
    }
    const org = manualOrg.trim();
    if (!org) {
      if (!process.stdin.isTTY) {
        throw organizationRequiredError();
      }
      lastError = organizationRequiredError();
      warn('Organization key is required.');
      continue;
    }

    const access = await client.resolveOrganizationAccess(org);
    if (access.status === 'accessible') {
      return org;
    }
    lastError = organizationAccessError(org, access);
    if (access.status !== 'not_found' || !process.stdin.isTTY) {
      throw lastError;
    }
    warn(`Organization '${org}' not found or not accessible. Keys are lowercase.`);
  }

  throw lastError;
}

async function listMemberOrganizations(
  client: SonarQubeClient,
): Promise<{ organizations: Organization[]; total: number }> {
  try {
    return await client.listUserOrganizations();
  } catch (error) {
    throw new CommandFailedError(`Could not list your organizations: ${(error as Error).message}`, {
      remediationHint:
        "Check your network connection and the server status, then rerun 'sonar auth login', or pass -o/--org to select an organization directly.",
    });
  }
}

async function getUserSelectedOrganization(client: SonarQubeClient): Promise<string> {
  // Deduce organization from API: if user is member of exactly one org, use it
  const { organizations: memberOrgs, total: orgTotal } = await listMemberOrganizations(client);
  if (memberOrgs.length === 1 && orgTotal === 1) {
    const singleOrg = memberOrgs[0].key;
    print(`Using organization (only member): ${singleOrg}`);
    return singleOrg;
  }

  // No org memberships — prompt for manual entry
  if (memberOrgs.length === 0) {
    return promptForOrganizationKey(client);
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
    return promptForOrganizationKey(client);
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
    await assertOrganizationAccessible(client, org);
    print(`Using organization: ${org}`);
    return org;
  }

  // Try to find organization in project configs first (skip the org listing)
  const configOrg = await discoverOrganization();
  if (configOrg) {
    const access = await client.resolveOrganizationAccess(configOrg);
    if (access.status === 'accessible') {
      print(`Using organization from config: ${configOrg}`);
      return configOrg;
    }
    // A stale key in a checked-in file cannot be corrected from here, so fall through to the
    // user's memberships rather than ending a login they can still complete. That lookup resolves
    // a single membership without asking anything, so it is worth trying on piped input too.
    if (access.status === 'check_failed') {
      throw organizationAccessError(configOrg, access);
    }
    warn(`Organization '${configOrg}' from project config is not accessible. Keys are lowercase.`);
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
