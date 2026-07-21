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

import { warn } from '../../core/ui';
import type { AuthConnection } from '../../lib/state.ts';
import { SonarQubeClient } from '../../sonarqube/client.ts';

export type RevokeServerTokenResult =
  | { status: 'success' }
  | { status: 'skipped'; message: string }
  | { status: 'failed'; message: string };

export interface ReportRevokeServerTokenOutcomeOptions {
  continuingMessage: string;
  serverUrl?: string;
}

/**
 * Surface a best-effort revoke outcome to the user. Skipped/failed paths warn;
 * callers supply the continuation line shown after a failed server revoke.
 */
export function reportRevokeServerTokenOutcome(
  outcome: RevokeServerTokenResult,
  options: ReportRevokeServerTokenOutcomeOptions,
): void {
  switch (outcome.status) {
    case 'success':
      return;
    case 'skipped':
      warn(outcome.message);
      return;
    case 'failed': {
      const message = options.serverUrl
        ? `${outcome.message} for ${options.serverUrl}. ${options.continuingMessage}`
        : `${outcome.message}. ${options.continuingMessage}`;
      warn(message);
    }
  }
}

/**
 * Attempt to revoke the server-side token before local cleanup.
 * Best-effort: callers decide how to surface skipped/failed outcomes.
 */
export async function revokeServerTokenIfPossible(
  connection: AuthConnection,
  token: string | undefined,
): Promise<RevokeServerTokenResult> {
  if (!connection.tokenName) {
    return {
      status: 'skipped',
      message:
        'The server-side token name is unknown for this connection, so the token could not be revoked automatically. Revoke it manually on the server if needed.',
    };
  }

  if (!token) {
    return {
      status: 'skipped',
      message: `Could not retrieve the local token from the keychain, so the server-side token "${connection.tokenName}" could not be revoked automatically. Revoke it manually on the server if needed.`,
    };
  }

  try {
    await new SonarQubeClient(connection.serverUrl, token).revokeUserToken(connection.tokenName);
    return { status: 'success' };
  } catch (error) {
    return {
      status: 'failed',
      message: `Failed to revoke the server-side token "${connection.tokenName}": ${(error as Error).message}`,
    };
  }
}
