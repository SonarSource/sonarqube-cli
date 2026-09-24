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
  ENV_ORG,
  ENV_SERVER,
  ENV_TOKEN,
  isSonarQubeCloud,
  type ResolvedAuth,
} from '@/core/auth/auth-resolver.ts';
import type { TokenCheckResult } from '@/core/auth/token.ts';
import { checkTokenStatus } from '@/core/auth/token.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { OrganizationsClient } from '@/core/server/organizations.ts';
import { getActiveConnection } from '@/core/state/state-manager.ts';
import { loadState } from '@/core/state/state-repository.ts';
import { NOTE_STYLES } from '@/core/ui/colors.ts';
import type { Console } from '@/core/ui/console.ts';

export const VALID_FORMATS = ['text', 'json'];
type AuthStatusFormat = 'text' | 'json';

export interface AuthStatusOptions {
  format?: string;
}

interface AuthStatusJson {
  status: 'not_authenticated' | 'token_missing' | 'connected' | 'token_invalid' | 'unreachable';
  server?: string;
  org?: string;
  source?: string;
  orgAccessible?: boolean;
  message?: string;
}

function printJsonStatus(console: Console, payload: AuthStatusJson): void {
  console.print(JSON.stringify(payload, null, 2));
}

function orgFields(
  orgKey: string | undefined,
  extra?: Partial<AuthStatusJson>,
): Partial<AuthStatusJson> {
  return orgKey ? { org: orgKey, ...extra } : {};
}

function connectionLines(serverUrl: string, orgKey: string | undefined): string[] {
  return [`Server  ${serverUrl}`, ...(orgKey ? [`Org     ${orgKey}`] : [])];
}

function displayTokenMissing(
  console: Console,
  serverUrl: string,
  orgKey: string | undefined,
  format: AuthStatusFormat,
): void {
  if (format === 'json') {
    printJsonStatus(console, {
      status: 'token_missing',
      server: serverUrl,
      ...orgFields(orgKey),
    });
    return;
  }
  console.note(connectionLines(serverUrl, orgKey), '✗ Token missing', NOTE_STYLES.error);
}

function displayTokenStatus(
  console: Console,
  serverUrl: string,
  orgKey: string | undefined,
  result: TokenCheckResult,
  format: AuthStatusFormat,
): void {
  if (result.status === 'valid') {
    displayConnected(console, serverUrl, 'OS Keychain', orgKey, format);
    return;
  }

  if (format === 'json') {
    if (result.status === 'invalid') {
      printJsonStatus(console, {
        status: 'token_invalid',
        server: serverUrl,
        ...orgFields(orgKey),
      });
    } else {
      printJsonStatus(console, {
        status: 'unreachable',
        server: serverUrl,
        ...orgFields(orgKey),
        message: result.errorMessage ?? 'Could not connect to the server to verify the token',
      });
    }
    return;
  }

  const lines = connectionLines(serverUrl, orgKey);
  if (result.status === 'invalid') {
    console.note(lines, '✗ Token invalid', NOTE_STYLES.error);
  } else {
    const detail = result.errorMessage
      ? `Could not connect to the server to verify the token: ${result.errorMessage}`
      : 'Could not connect to the server to verify the token';
    console.note([...lines, '', detail], '⚠ Cannot reach server', NOTE_STYLES.warn);
  }
}

async function hasMissingOrganizationMembership(
  serverUrl: string,
  token: string,
  orgKey: string | undefined,
): Promise<boolean> {
  if (!orgKey || !isSonarQubeCloud(serverUrl)) return false;
  const membership = await new OrganizationsClient(
    new SonarHttpClient(serverUrl, token),
  ).checkMembership(orgKey);
  return membership.status === 'not_member';
}

function displayOrganizationMembershipMismatch(
  console: Console,
  serverUrl: string,
  orgKey: string,
  source: string,
  format: AuthStatusFormat,
): void {
  if (format === 'json') {
    printJsonStatus(console, {
      status: 'connected',
      server: serverUrl,
      org: orgKey,
      source,
      orgAccessible: false,
    });
    return;
  }

  console.note(
    [
      ...connectionLines(serverUrl, orgKey),
      '',
      'This token resolves no membership for that organization. Either regenerate it',
      '(My Account > Access Tokens) — a token created before you joined the',
      'organization stays invalid for it — or ask an organization administrator to add',
      'your account.',
    ],
    `! Connected, but organization '${orgKey}' is not accessible with this token`,
    NOTE_STYLES.warn,
  );
}

function resolveAuthStatusFormat(options: AuthStatusOptions): AuthStatusFormat {
  const format = (options.format ?? 'text').toLowerCase();
  if (!VALID_FORMATS.includes(format)) {
    throw new InvalidOptionError(
      `Invalid format: '${format}'. Must be one of: ${VALID_FORMATS.join(', ')}`,
    );
  }
  return format as AuthStatusFormat;
}

/**
 * Text mode throws so the shared command framework renders its `❌`/`💡` error
 * presentation. JSON mode has already printed the status object at this point, so it
 * sets the exit code directly instead — throwing would make `runCommand()` print that
 * same human-formatted error alongside the JSON, defeating the point of `--format json`.
 */
function failAuthStatus(format: AuthStatusFormat, error: CommandFailedError): void {
  if (format === 'json') {
    process.exitCode = error.exitCode;
    return;
  }
  throw error;
}

function displayNotAuthenticated(console: Console, format: AuthStatusFormat): void {
  if (format === 'json') {
    printJsonStatus(console, { status: 'not_authenticated' });
    return;
  }
  console.print('No saved connection');
}

async function displayEnvironmentConnectionStatus(
  console: Console,
  auth: ResolvedAuth,
  format: AuthStatusFormat,
): Promise<void> {
  let source = `env vars:  ${ENV_TOKEN}, ${ENV_SERVER}`;
  if (auth.connectionType === 'cloud') {
    source = process.env[ENV_SERVER]
      ? `env vars:  ${ENV_TOKEN}, ${ENV_ORG}, ${ENV_SERVER}`
      : `env vars:  ${ENV_TOKEN}, ${ENV_ORG}`;
  }
  if (await hasMissingOrganizationMembership(auth.serverUrl, auth.token, auth.orgKey)) {
    displayOrganizationMembershipMismatch(console, auth.serverUrl, auth.orgKey!, source, format);
    return;
  }
  displayConnected(console, auth.serverUrl, source, auth.orgKey, format);
}

function displayConnected(
  console: Console,
  serverUrl: string,
  source: string,
  orgKey: string | undefined,
  format: AuthStatusFormat,
): void {
  if (format === 'json') {
    printJsonStatus(console, {
      status: 'connected',
      server: serverUrl,
      source,
      ...orgFields(orgKey, { orgAccessible: true }),
    });
    return;
  }

  console.note(
    [...connectionLines(serverUrl, orgKey), '', `Source  ${source}`],
    '✓ Connected',
    NOTE_STYLES.success,
  );
}

export async function authStatus(
  options: AuthStatusOptions,
  ctx: CommandInvocationContext,
): Promise<void> {
  const { console } = ctx;
  const authStatusFormat = resolveAuthStatusFormat(options);

  const authResult = await ctx.resolveAuth();
  if (authResult.isErr()) {
    throw authResult.error;
  }
  const auth = authResult.value;

  if (auth?.comesFromEnv()) {
    await displayEnvironmentConnectionStatus(console, auth, authStatusFormat);
    return;
  }

  if (!auth) {
    const state = loadState();
    if (state.auth.connections.length === 0) {
      displayNotAuthenticated(console, authStatusFormat);
      failAuthStatus(
        authStatusFormat,
        new CommandFailedError('Authentication check failed.', {
          remediationHint: "Run 'sonar auth login' to authenticate.",
        }),
      );
      return;
    }

    const conn = getActiveConnection(state) ?? state.auth.connections[0];
    displayTokenMissing(console, conn.serverUrl, conn.orgKey, authStatusFormat);
    failAuthStatus(
      authStatusFormat,
      new CommandFailedError('Authentication check failed.', {
        remediationHint: "Run 'sonar auth login' to restore the token.",
      }),
    );
    return;
  }

  const status =
    authStatusFormat === 'json'
      ? await checkTokenStatus(auth.serverUrl, auth.token)
      : await console.withSpinner('Verifying token...', () =>
          checkTokenStatus(auth.serverUrl, auth.token),
        );
  if (authStatusFormat !== 'json') {
    console.blank();
  }

  if (
    status.status === 'valid' &&
    (await hasMissingOrganizationMembership(auth.serverUrl, auth.token, auth.orgKey))
  ) {
    displayOrganizationMembershipMismatch(
      console,
      auth.serverUrl,
      auth.orgKey!,
      'OS Keychain',
      authStatusFormat,
    );
  } else {
    displayTokenStatus(console, auth.serverUrl, auth.orgKey, status, authStatusFormat);
  }

  if (status.status === 'unreachable') {
    const message = status.errorMessage
      ? `Connection check failed: ${status.errorMessage}`
      : 'Connection check failed.';
    failAuthStatus(
      authStatusFormat,
      new CommandFailedError(message, {
        remediationHint: 'Check the server URL and network connectivity, then retry.',
      }),
    );
    return;
  }
  if (status.status !== 'valid') {
    failAuthStatus(
      authStatusFormat,
      new CommandFailedError('Authentication check failed.', {
        remediationHint: "Run 'sonar auth login' to reauthenticate.",
      }),
    );
  }
}
