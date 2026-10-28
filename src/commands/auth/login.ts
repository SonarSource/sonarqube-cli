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
import { switchOrganization } from '@/core/auth/auth-connection-recorder.ts';
import {
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
import { getToken as getKeystoreToken, normalizeServerUrl } from '@/core/host/keychain.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { OrganizationsClient } from '@/core/server/organizations.ts';
import { INVALID_SERVER_URL_MESSAGE } from '@/core/server/server-url-validation.ts';
import type { AuthConnection } from '@/core/state/state.ts';
import { getActiveConnection } from '@/core/state/state-manager.ts';
import { loadState } from '@/core/state/state-repository.ts';
import { NOTE_STYLES } from '@/core/ui/colors.ts';
import type { Console } from '@/core/ui/console.ts';

import { isSameServer, persistLoginCredentials } from './persist-login.ts';
import {
  reportRevokeServerTokenOutcome,
  revokeServerTokenIfPossible,
} from './revoke-server-token.ts';
import { confirmServerTrust, resolveServer } from './select-server.ts';

type LoginStep =
  | { kind: 'new_login'; tokenSaved: true }
  | { kind: 'stored_login'; auth: BrowserAuthResult; tokenSaved: true }
  | { kind: 'switch_organization'; org: string; auth: BrowserAuthResult; tokenSaved: false }
  | { kind: 'keep_organization'; org: string; tokenSaved: false };

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
  const server = await resolveServer(options.server, console);
  const isCloud = isSonarQubeCloud(server);
  if (!isCloud) {
    await confirmServerTrust(server, console);
  }

  // SonarQube Server has no organizations, so --org cannot mean anything there. Dropping it here
  // keeps the recorded connection and the resolved organization consistent.
  const orgOption = isCloud ? options.org?.trim() : undefined;

  try {
    const storedLogin = await findStoredLogin(server);
    if (storedLogin) {
      console.info(`Already authenticated on ${server}.`);
    }

    const step = await resolveLoginStep(server, storedLogin, orgOption, console);
    await executeLoginStep(step, server, isCloud, orgOption, console, invocationAuth?.orgKey);

    if (step.tokenSaved && invocationAuth?.comesFromEnv()) {
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

async function resolveLoginStep(
  server: string,
  storedLogin: BrowserAuthResult | undefined,
  orgOption: string | undefined,
  console: Console,
): Promise<LoginStep> {
  if (!storedLogin) {
    return { kind: 'new_login', tokenSaved: true };
  }
  if (!orgOption) {
    return { kind: 'stored_login', auth: storedLogin, tokenSaved: true };
  }
  return resolveOrganizationStep(server, orgOption, storedLogin, console);
}

async function resolveOrganizationStep(
  server: string,
  org: string,
  auth: BrowserAuthResult,
  console: Console,
): Promise<LoginStep> {
  const activeConnection = getActiveConnection(loadState());
  const activeOrgKey = isSameServer(activeConnection, server)
    ? activeConnection?.orgKey
    : undefined;

  const membership = await new OrganizationsClient(
    new SonarHttpClient(server, auth.token),
  ).checkMembership(org);
  if (membership.status === 'check_failed') {
    throw organizationMembershipError(org, membership);
  }

  if (membership.status === 'not_member') {
    console.info(`Your account isn't a member of '${org}'.`);
    if (await confirmSignInWithDifferentAccount(console)) {
      return { kind: 'new_login', tokenSaved: true };
    }
    if (activeOrgKey) {
      console.print(`Active organization unchanged: ${activeOrgKey}`);
    }
    throw new CommandFailedError(`Could not switch to '${org}'`, {
      remediationHint: `Check the organization key, or ask an org admin to add you. To use another account, run 'sonar auth logout', then 'sonar auth login --org ${org}'.`,
    });
  }

  if (activeOrgKey === org) {
    return { kind: 'keep_organization', org, tokenSaved: false };
  }

  return { kind: 'switch_organization', org, auth, tokenSaved: false };
}

async function confirmSignInWithDifferentAccount(console: Console): Promise<boolean | null> {
  const canPrompt = process.stdin.isTTY || Boolean(process.env.SONARQUBE_CLI_MOCK_TTY);
  return canPrompt && (await console.confirmPrompt('Sign in with a different account?', false));
}

async function executeLoginStep(
  step: LoginStep,
  server: string,
  isCloud: boolean,
  orgOption: string | undefined,
  console: Console,
  invocationOrgKey: string | undefined,
): Promise<void> {
  switch (step.kind) {
    case 'new_login':
      await loginWithNewToken(server, isCloud, orgOption, console, invocationOrgKey);
      break;
    case 'stored_login':
      await loginWithStoredToken(server, isCloud, step.auth, console, invocationOrgKey);
      break;
    case 'switch_organization':
      await switchStoredLoginOrganization(server, step.org, step.auth, console);
      break;
    case 'keep_organization':
      console.print(`Already using organization: ${step.org}`);
      break;
  }
}

async function switchStoredLoginOrganization(
  server: string,
  org: string,
  auth: BrowserAuthResult,
  console: Console,
): Promise<void> {
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

async function loginWithStoredToken(
  server: string,
  isCloud: boolean,
  auth: BrowserAuthResult,
  console: Console,
  activeOrgKey: string | undefined,
): Promise<void> {
  const org = await resolveOrganization(server, isCloud, undefined, auth, console, activeOrgKey);
  await completeLogin(server, isCloud, org, auth, console);
}

/**
 * Sign in through the browser and save the new token.
 *
 * When the organization is rejected, discard the token this login just minted, so a typo does not
 * leave an unusable token in the user's account.
 */
async function loginWithNewToken(
  server: string,
  isCloud: boolean,
  orgOption: string | undefined,
  console: Console,
  activeOrgKey: string | undefined,
): Promise<void> {
  const auth = await generateToken(server, console);

  let org: string | undefined;
  try {
    org = await resolveOrganization(server, isCloud, orgOption, auth, console, activeOrgKey);
  } catch (error) {
    await discardGeneratedToken(server, auth.token, auth.tokenName, console);
    throw error;
  }

  await completeLogin(server, isCloud, org, auth, console);
}

async function completeLogin(
  server: string,
  isCloud: boolean,
  org: string | undefined,
  auth: BrowserAuthResult,
  console: Console,
): Promise<void> {
  await persistLoginCredentials(server, isCloud, org, auth.token, {
    tokenName: auth.tokenName,
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
 */
async function resolveOrganization(
  server: string,
  isCloud: boolean,
  orgOption: string | undefined,
  auth: BrowserAuthResult,
  console: Console,
  activeOrgKey: string | undefined,
): Promise<string | undefined> {
  if (!isCloud) {
    return undefined;
  }

  return await validateOrSelectOrganization(
    new OrganizationsClient(new SonarHttpClient(server, auth.token)),
    orgOption,
    console,
    activeOrgKey,
  );
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

async function findStoredLogin(server: string): Promise<BrowserAuthResult | undefined> {
  const recordedConnection = findRecordedConnection(server);
  const existingToken = recordedConnection ? await getKeystoreToken(server) : null;
  if (!existingToken) {
    return undefined;
  }

  return { token: existingToken, tokenName: recordedConnection?.tokenName };
}

async function generateToken(server: string, console: Console): Promise<BrowserAuthResult> {
  console.print(`\nAuthenticating with: ${server}`);
  const authResult = await generateTokenViaBrowser(server, console);
  console.discreetSuccess('Token received');
  return authResult;
}

function findRecordedConnection(server: string): AuthConnection | undefined {
  const state = loadState();
  const activeId = getActiveConnection(state)?.id;
  const matching = state.auth.connections.filter(
    (connection) => normalizeServerUrl(connection.serverUrl) === normalizeServerUrl(server),
  );
  return matching.find((connection) => connection.id === activeId) ?? matching[0];
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
