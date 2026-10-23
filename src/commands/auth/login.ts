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

import {
  assertOrganizationMember,
  organizationMembershipError,
  validateOrSelectOrganization,
} from '@/commands/components/organization/select.ts';
import {
  recordConnectionFromAuth,
  switchOrganization,
} from '@/core/auth/auth-connection-recorder.ts';
import {
  assertValidServerUrl,
  ENV_ORG,
  ENV_SERVER,
  ENV_TOKEN,
  isSonarQubeCloud,
  isValidServerUrl,
  ResolvedAuth,
} from '@/core/auth/auth-resolver.ts';
import {
  type BrowserAuthResult,
  checkTokenStatus,
  generateTokenViaBrowser,
  readTokenFromStdin,
} from '@/core/auth/token.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import { type CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { SONARCLOUD_URL, SONARCLOUD_US_URL } from '@/core/config-constants.ts';
import {
  deleteStaleTokens,
  getToken as getKeystoreToken,
  normalizeServerUrl,
  saveToken,
} from '@/core/host/keychain.ts';
import { discoverServer } from '@/core/project-discovery/project-info.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { OrganizationsClient } from '@/core/server/organizations.ts';
import { INVALID_SERVER_URL_MESSAGE } from '@/core/server/server-url-validation.ts';
import { cloudRegionFromUrl } from '@/core/server/sonarcloud-region.ts';
import type { AuthConnection } from '@/core/state/state.ts';
import { addOrUpdateConnection, getActiveConnection } from '@/core/state/state-manager.ts';
import { loadState, updateState } from '@/core/state/state-repository.ts';
import { NOTE_STYLES } from '@/core/ui/colors.ts';
import type { Console } from '@/core/ui/console.ts';

import {
  reportRevokeServerTokenOutcome,
  revokeServerTokenIfPossible,
} from './revoke-server-token.ts';

/**
 * Login command - authenticate and save token with organization
 */
export async function authLogin(
  options: AuthLoginOptions,
  ctx: CommandInvocationContext,
): Promise<void> {
  const { console } = ctx;
  validateLoginOptions(options);
  if (options.withToken) {
    await authLoginWithToken(options, console);
    return;
  }
  const authResult = await ctx.resolveAuth({ silent: true });
  if (authResult.isErr()) {
    throw authResult.error;
  }
  const invocationAuth = authResult.value;
  await warnIfEnvAuthPresent(ctx, invocationAuth);
  const server = await resolveServer(options, console);
  const isCloud = isSonarQubeCloud(server);
  if (!isCloud) {
    await confirmServerTrust(server, console);
  }

  // SonarQube Server has no organizations, so --org cannot mean anything there. Dropping it here
  // keeps the recorded connection and the resolved organization consistent.
  const orgOption = isCloud ? options.org?.trim() : undefined;

  try {
    const auth = await getOrGenerateToken(server, console);

    if (auth.reusedExistingToken && orgOption) {
      await switchReusedLoginOrganization(server, orgOption, auth, console);
    } else {
      await completeLogin(server, isCloud, orgOption, auth, console, invocationAuth?.orgKey);
    }

    if (invocationAuth?.comesFromEnv()) {
      console.warn(
        ` Token saved, but environment variables take precedence and will be used instead.\n   → Unset ${ENV_TOKEN} to use the saved token`,
      );
    }
  } finally {
    // The token step leaves stdin resumed for Windows keypresses, and a resumed TTY keeps the
    // process alive. Release it on every exit path, not only on success. That step resumes stdin
    // when it fails too (Ctrl+C at the browser prompt), so it has to sit inside the try.
    if (process.stdin.isTTY) {
      process.stdin.pause();
    }
  }
}

async function switchReusedLoginOrganization(
  server: string,
  org: string,
  auth: BrowserAuthResult,
  console: Console,
): Promise<void> {
  const activeConnection = getActiveConnection(loadState());
  const activeOrgKey = isSameServer(activeConnection, server)
    ? activeConnection?.orgKey
    : undefined;

  await assertMemberOrDeclineSwitch(server, org, auth.token, activeOrgKey, console);

  if (activeOrgKey === org) {
    console.print(`Already using organization: ${org}`);
    return;
  }

  await switchOrganization(
    new ResolvedAuth({
      token: auth.token,
      serverUrl: server,
      connectionType: 'cloud',
      source: 'state',
    }),
    org,
    auth.tokenName,
  );
  console.print('→ Next time, switch directly: sonar auth org <org>');
  console.success(`Switched to '${org}'`);
}

async function assertMemberOrDeclineSwitch(
  server: string,
  org: string,
  token: string,
  activeOrgKey: string | undefined,
  console: Console,
): Promise<void> {
  const membership = await new OrganizationsClient(
    new SonarHttpClient(server, token),
  ).checkMembership(org);
  if (membership.status === 'member') {
    return;
  }
  if (membership.status === 'check_failed') {
    throw organizationMembershipError(org, membership);
  }

  console.info(`Your account isn't a member of '${org}'.`);
  if (activeOrgKey) {
    console.print(`Active organization unchanged: ${activeOrgKey}`);
  }
  throw new CommandFailedError(`Could not switch to '${org}'`, {
    remediationHint: `Check the organization key, or ask an org admin to add you. To use another account, run 'sonar auth logout', then 'sonar auth login --org ${org}'.`,
  });
}

async function completeLogin(
  server: string,
  isCloud: boolean,
  orgOption: string | undefined,
  auth: BrowserAuthResult & { reusedExistingToken: boolean },
  console: Console,
  activeOrgKey: string | undefined,
): Promise<void> {
  const org = await resolveOrganization(server, isCloud, orgOption, auth, console, activeOrgKey);

  await persistLoginCredentials(server, isCloud, org, auth.token, {
    tokenName: auth.tokenName,
    reusedExistingToken: auth.reusedExistingToken,
    console,
  });

  const displayServer = isCloud ? `${server} (${org})` : server;
  console.success(`Authentication successful for: ${displayServer}`);
}

async function authLoginWithToken(options: AuthLoginOptions, console: Console): Promise<void> {
  assertNoEnvironmentAuthentication();
  if (process.stdin.isTTY) {
    throw new InvalidOptionError(
      '--with-token reads a token from standard input.',
      'Pipe or redirect a token, for example: sonar auth login --with-token --server <url> < token.txt',
    );
  }

  let token: string;
  try {
    token = await readTokenFromStdin();
  } catch (error) {
    throw new CommandFailedError(
      error instanceof Error ? error.message : 'Failed to read token from standard input.',
    );
  }

  const server = options.server;
  if (server === undefined) {
    throw new InvalidOptionError('--server is required with --with-token.');
  }
  const isCloud = isSonarQubeCloud(server);
  const org = isCloud ? options.org?.trim() : undefined;
  const tokenStatus = await checkTokenStatus(server, token);
  if (tokenStatus.status === 'invalid') {
    throw new CommandFailedError(`The supplied token is invalid for ${server}.`);
  }
  if (tokenStatus.status === 'unreachable') {
    throw new CommandFailedError(`Could not validate the supplied token against ${server}.`, {
      remediationHint: 'Check the server URL, network connection, and server status, then retry.',
    });
  }

  if (org) {
    await assertOrganizationMember(
      new OrganizationsClient(new SonarHttpClient(server, token)),
      org,
    );
    console.print(`Using organization: ${org}`);
  }

  await persistLoginCredentials(server, isCloud, org, token, { refreshIdentity: true, console });

  const displayServer = isCloud ? `${server} (${org})` : server;
  console.success(`Authentication successful for: ${displayServer}`);
}

interface PersistLoginOptions {
  tokenName?: string;
  reusedExistingToken?: boolean;
  refreshIdentity?: boolean;
  console?: Console;
}

async function persistLoginCredentials(
  server: string,
  isCloud: boolean,
  org: string | undefined,
  token: string,
  options: PersistLoginOptions = {},
): Promise<void> {
  const state = loadState();
  const existingConnection = getActiveConnection(state);
  const sameServerAsExisting = isSameServer(existingConnection, server);

  await revokePreviousLoginToken(existingConnection, server, token, options);

  await deleteStaleTokens(state.auth.connections, server);
  await saveToken(server, token);

  const connectionTokenName =
    options.reusedExistingToken && existingConnection && sameServerAsExisting
      ? existingConnection.tokenName
      : options.tokenName;
  const actualToken = token || (await getKeystoreToken(server));

  if (actualToken) {
    try {
      await recordConnectionFromAuth(
        new ResolvedAuth({
          token: actualToken,
          serverUrl: server,
          orgKey: org,
          connectionType: isCloud ? 'cloud' : 'on-premise',
          source: 'state',
        }),
        {
          tokenName: connectionTokenName,
          force: true,
          refreshIdentity: options.refreshIdentity,
        },
      );
    } catch (error) {
      throw new CommandFailedError(
        `Token saved, but login state could not be updated: ${String(error)}`,
      );
    }
    return;
  }

  try {
    updateState((latest) => {
      addOrUpdateConnection(latest, server, isCloud ? 'cloud' : 'on-premise', {
        orgKey: org,
        region: cloudRegionFromUrl(server),
        tokenName: connectionTokenName,
      });
    });
  } catch (error) {
    throw new CommandFailedError(
      `Token saved, but login state could not be updated: ${String(error)}`,
    );
  }
}

async function revokePreviousLoginToken(
  connection: AuthConnection | undefined,
  server: string,
  token: string,
  options: PersistLoginOptions,
): Promise<void> {
  if (options.reusedExistingToken || !connection?.tokenName || !isSameServer(connection, server)) {
    return;
  }
  const previousToken = await getKeystoreToken(server);
  if (!previousToken || previousToken === token) {
    return;
  }
  const outcome = await revokeServerTokenIfPossible(
    { serverUrl: server, tokenName: connection.tokenName },
    previousToken,
  );
  if (options.console) {
    reportRevokeServerTokenOutcome(outcome, {
      continuingMessage: 'Continuing with login.',
      console: options.console,
    });
  }
}

function isSameServer(connection: AuthConnection | undefined, server: string): boolean {
  return (
    connection !== undefined &&
    normalizeServerUrl(connection.serverUrl) === normalizeServerUrl(server)
  );
}

function assertNoEnvironmentAuthentication(): void {
  if (!process.env[ENV_TOKEN] || !(process.env[ENV_SERVER] || process.env[ENV_ORG])) {
    return;
  }
  throw new CommandFailedError('Environment variable authentication is already active.', {
    remediationHint: `Unset ${ENV_TOKEN} and ${ENV_SERVER}/${ENV_ORG} before using --with-token.`,
  });
}

/**
 * Environment variable authentication always wins over whatever this command saves (see
 * `AuthResolver` in `auth-resolver.ts`), so a login run while it is active would not change what
 * the CLI actually uses. Warn instead of silently doing pointless work, and let the user opt out
 * of a token they know will not be used.
 */
async function warnIfEnvAuthPresent(
  ctx: CommandInvocationContext,
  auth: ResolvedAuth | null,
): Promise<void> {
  if (!auth?.comesFromEnv()) {
    return;
  }
  const { console } = ctx;
  console.note(
    [
      'You are already authenticated via environment variables.',
      'This login will be ignored until those variables have been unset.',
      "→ Run 'sonar auth status' to see which credentials are currently in use.",
    ],
    '⚠ Environment variable authentication detected',
    NOTE_STYLES.warn,
  );

  const proceed = await console.confirmPrompt(
    'Log in anyway and save a token to the keychain?',
    false,
  );
  if (!proceed) {
    throw new CommandFailedError('Login cancelled');
  }
}

/**
 * Resolve the organization, which only SonarQube Cloud has.
 *
 * When it is rejected, discard the token this login just minted, so a typo does not leave an
 * unusable token in the user's account.
 */
async function resolveOrganization(
  server: string,
  isCloud: boolean,
  orgOption: string | undefined,
  auth: BrowserAuthResult & { reusedExistingToken: boolean },
  console: Console,
  activeOrgKey: string | undefined,
): Promise<string | undefined> {
  if (!isCloud) {
    return undefined;
  }

  try {
    return await validateOrSelectOrganization(
      new OrganizationsClient(new SonarHttpClient(server, auth.token)),
      orgOption,
      console,
      activeOrgKey,
    );
  } catch (error) {
    if (!auth.reusedExistingToken) {
      await discardGeneratedToken(server, auth.token, auth.tokenName, console);
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
  console: Console,
): Promise<void> {
  const outcome = await revokeServerTokenIfPossible({ serverUrl, tokenName }, token);
  reportRevokeServerTokenOutcome(outcome, {
    continuingMessage: 'Revoke it manually on the server if needed.',
    console,
  });
}

/**
 * Get token for authentication
 */
async function getOrGenerateToken(
  server: string,
  console: Console,
): Promise<BrowserAuthResult & { reusedExistingToken: boolean }> {
  const recordedConnection = findRecordedConnection(server);
  const existingToken = recordedConnection ? await getKeystoreToken(server) : null;
  if (existingToken) {
    console.info(`Already authenticated on ${server} — no re-authentication needed.`);
    return {
      token: existingToken,
      tokenName: recordedConnection?.tokenName,
      reusedExistingToken: true,
    };
  }

  console.print(`\nAuthenticating with: ${server}`);
  const authResult = await generateTokenViaBrowser(server, console);
  console.discreetSuccess('Token received');
  return { ...authResult, reusedExistingToken: false };
}

function findRecordedConnection(server: string): AuthConnection | undefined {
  const state = loadState();
  const activeId = getActiveConnection(state)?.id;
  const matching = state.auth.connections.filter(
    (connection) =>
      !connection.envOnly &&
      normalizeServerUrl(connection.serverUrl) === normalizeServerUrl(server),
  );
  return matching.find((connection) => connection.id === activeId) ?? matching[0];
}

export async function confirmServerTrust(server: string, console: Console): Promise<void> {
  if (isSonarQubeCloud(server)) {
    return;
  }
  console.warn('Only connect to servers you trust.');
  const confirmed = await console.confirmPrompt(`Connect to: ${server}?`, true);
  if (!confirmed) {
    throw new CommandFailedError('Login cancelled');
  }
}

async function selectServerFromPrompt(console: Console): Promise<string> {
  const serverType = await console.selectPrompt('Where would you like to connect?', [
    { value: 'cloud', label: 'SonarQube Cloud' },
    { value: 'server', label: 'SonarQube Server (self-hosted)' },
  ]);

  if (serverType === null) {
    throw new CommandFailedError('Server selection cancelled');
  }

  if (serverType === 'cloud') {
    const region = await console.selectPrompt('Which SonarQube Cloud region?', [
      { value: SONARCLOUD_URL, label: 'EU (sonarcloud.io)' },
      { value: SONARCLOUD_US_URL, label: 'US (sonarqube.us)' },
    ]);
    if (region === null) {
      throw new CommandFailedError('Server selection cancelled');
    }
    return region;
  }

  const url = await console.promptUntilValid(
    'Enter server URL',
    (v) => !!v.trim() && isValidServerUrl(v.trim()),
    'Please enter a valid URL (for example https://sonarqube.mycompany.com/sonarqube).',
  );
  if (url === null) {
    throw new CommandFailedError('Server selection cancelled');
  }
  return url.trim();
}

async function resolveServer(options: AuthLoginOptions, console: Console): Promise<string> {
  let server: string;
  if (options.server) {
    server = options.server;
  } else {
    const configServer = await discoverServer(console);
    if (configServer) {
      assertValidServerUrl(
        configServer,
        'Fix serverUrl in .sonar-config.json or pass --server <url>.',
      );
      return configServer;
    }
    server = await selectServerFromPrompt(console);
  }
  assertValidServerUrl(
    server,
    "Run 'sonar auth login' again and enter an HTTP(S) URL with a host.",
  );
  return server;
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

  if (options.server !== undefined && !isValidServerUrl(options.server)) {
    throw new InvalidOptionError(
      `Invalid server URL. ${INVALID_SERVER_URL_MESSAGE}`,
      'Use --server <url> (for example https://sonarcloud.io), or run sonar auth login without --server.',
    );
  }

  if (options.withToken && options.server === undefined) {
    throw new InvalidOptionError('--server is required with --with-token.', 'Use --server <url>.');
  }

  if (
    options.withToken &&
    options.server !== undefined &&
    isSonarQubeCloud(options.server) &&
    options.org === undefined
  ) {
    throw new InvalidOptionError(
      '--org is required for SonarQube Cloud with --with-token.',
      'Use --org <organization-key>.',
    );
  }
}

export interface AuthLoginOptions {
  server?: string;
  org?: string;
  withToken?: boolean;
}
