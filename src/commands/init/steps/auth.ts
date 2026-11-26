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

import { authLogin } from '@/commands/auth/login.ts';
import { AuthResolver, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { UsersClient } from '@/core/server/users.ts';

import type { InitTelemetryRecorder } from '../telemetry/init-telemetry-recorder.ts';
import { createOrganizationHook } from './organization.ts';

/**
 * Reuses the current login, or signs the user in through the browser. On SonarQube Cloud the
 * login also settles the organization. An account with none is offered the creation of one, and
 * `OrganizationCreationDeclined` ends the run when the user says no.
 */
export async function resolveInitAuth(
  ctx: CommandInvocationContext,
  interactive: boolean,
  dryRun = false,
  telemetry?: InitTelemetryRecorder,
): Promise<ResolvedAuth> {
  telemetry?.begin('login');
  const current = await ctx.resolveAuth({ silent: true });
  if (current.isErr()) {
    throw current.error;
  }
  if (current.value) {
    await validateActiveConnection(ctx, current.value);
    telemetry?.record('login', 'already_done');
    return current.value;
  }

  // Signing in saves credentials, and the preview needs the server to check keys and projects.
  if (dryRun) {
    throw new CommandFailedError(
      'Not signed in: a dry run cannot sign in, since that saves credentials.',
      {
        remediationHint:
          "Run 'sonar auth login', or set SONARQUBE_CLI_TOKEN together with SONARQUBE_CLI_SERVER or SONARQUBE_CLI_ORG.",
      },
    );
  }

  if (!interactive) {
    throw new CommandFailedError('Not signed in.', {
      remediationHint:
        "Run 'sonar auth login', or set SONARQUBE_CLI_TOKEN together with SONARQUBE_CLI_SERVER or SONARQUBE_CLI_ORG.",
    });
  }

  await authLogin({}, ctx, {
    onNoMemberships: createOrganizationHook(ctx.console, telemetry),
  });
  const fresh = await resolveFreshAuth();
  if (telemetry && !telemetry.has('login')) {
    telemetry.record('login', 'success');
  }
  return fresh;
}

/** Saved credentials may have expired or been revoked since login. */
async function validateActiveConnection(
  ctx: CommandInvocationContext,
  auth: ResolvedAuth,
): Promise<void> {
  const { httpClient } = ctx.withAuth(auth).connection;
  const status = await new UsersClient(httpClient)
    .checkTokenValidity()
    .mapErr(
      (cause) =>
        new CommandFailedError('Could not validate the active SonarQube connection.', {
          cause,
          remediationHint:
            'Check your network connection and the server status, then rerun the command.',
        }),
    )
    .orThrow();
  if (status === 'invalid') {
    throw new CommandFailedError('The active SonarQube token is invalid or expired.', {
      remediationHint: auth.comesFromEnv()
        ? 'Set SONARQUBE_CLI_TOKEN to a valid user token, then rerun the command.'
        : "Run 'sonar auth login' to re-authenticate, then rerun the command.",
    });
  }
}

/** The invocation's resolver memoized the pre-login answer, so read the new login with a new one. */
async function resolveFreshAuth(): Promise<ResolvedAuth> {
  const fresh = await new AuthResolver().resolveAuth({ silent: true });
  if (fresh.isErr()) {
    throw fresh.error;
  }
  if (!fresh.value) {
    throw new CommandFailedError('Sign-in finished, but no active connection was found.', {
      remediationHint: "Run 'sonar auth status' to inspect the saved connection.",
    });
  }
  return fresh.value;
}
