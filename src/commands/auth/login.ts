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
  assertOrganizationAccessible,
  validateOrSelectOrganization,
} from '@/commands/components/organization/select.ts';
import { recordConnectionFromAuth } from '@/core/auth/auth-connection-recorder.ts';
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
  saveToken,
} from '@/core/host/keychain.ts';
import { discoverServer } from '@/core/project-info.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { OrganizationsClient } from '@/core/server/organizations.ts';
import { cloudRegionFromUrl } from '@/core/server/sonarcloud-region.ts';
import { addOrUpdateConnection, getActiveConnection } from '@/core/state/state-manager.ts';
import { loadState, saveState } from '@/core/state/state-repository.ts';
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
  await confirmServerTrust(server, console);

  const isCloud = isSonarQubeCloud(server);
  // SonarQube Server has no organizations, so --org cannot mean anything there. Dropping it here
  // keeps the keychain account, the recorded connection and the resolved organization consistent.
  const orgOption = isCloud ? options.org?.trim() : undefined;

  try {
    const auth = await getOrGenerateToken(server, orgOption, console);
    const { token, tokenName, reusedExistingToken } = auth;

    const org = await resolveOrganization(
      server,
      isCloud,
      orgOption,
      auth,
      console,
      invocationAuth?.orgKey,
    );

    await persistLoginCredentials(server, isCloud, org, token, {
      tokenName,
      reusedExistingToken,
    });

    const displayServer = isCloud ? `${server} (${org})` : server;
    console.success(`Authentication successful for: ${displayServer}`);
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
    await assertOrganizationAccessible(
      new OrganizationsClient(new SonarHttpClient(server, token)),
      org,
    );
    console.print(`Using organization: ${org}`);
  }

  await persistLoginCredentials(server, isCloud, org, token, { refreshIdentity: true });

  const displayServer = isCloud ? `${server} (${org})` : server;
  console.success(`Authentication successful for: ${displayServer}`);
}

interface PersistLoginOptions {
  tokenName?: string;
  reusedExistingToken?: boolean;
  refreshIdentity?: boolean;
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

  await deleteStaleTokens(state.auth.connections, server, org);
  await saveToken(server, token, org);

  const connectionTokenName =
    options.reusedExistingToken &&
    existingConnection?.serverUrl === server &&
    existingConnection.orgKey === org
      ? existingConnection.tokenName
      : options.tokenName;
  const actualToken = token || (await getKeystoreToken(server, org));

  if (actualToken) {
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
    return;
  }

  addOrUpdateConnection(state, server, isCloud ? 'cloud' : 'on-premise', {
    orgKey: org,
    region: cloudRegionFromUrl(server),
    tokenName: connectionTokenName,
  });
  saveState(state);
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
  org: string | undefined,
  console: Console,
): Promise<BrowserAuthResult & { reusedExistingToken: boolean }> {
  const existingToken = await getKeystoreToken(server, org);
  if (existingToken) {
    const displayServer = isSonarQubeCloud(server) ? `${server} (${org})` : server;
    console.print(`Token already exists for: ${displayServer}`);
    console.print('You are already authenticated');
    return { token: existingToken, reusedExistingToken: true };
  }

  console.print(`\nAuthenticating with: ${server}`);
  const authResult = await generateTokenViaBrowser(server, console);
  console.discreetSuccess('Token received');
  return { ...authResult, reusedExistingToken: false };
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
      'Invalid server URL. It must be an absolute HTTP(S) URL with a host and no control characters.',
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
