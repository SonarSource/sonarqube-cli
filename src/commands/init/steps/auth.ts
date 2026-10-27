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
import { NoOrganizationMembershipError } from '@/commands/components/organization/select.ts';
import { AuthResolver, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';

/**
 * Reuses the current login, or signs the user in through the browser. On SonarQube Cloud the
 * login also settles the organization. Resolves to null when the account belongs to none.
 */
export async function resolveInitAuth(
  ctx: CommandInvocationContext,
  interactive: boolean,
): Promise<ResolvedAuth | null> {
  const current = await ctx.resolveAuth({ silent: true });
  if (current.isErr()) {
    throw current.error;
  }
  if (current.value) {
    return current.value;
  }

  if (!interactive) {
    throw new CommandFailedError('Not signed in.', {
      remediationHint:
        "Run 'sonar auth login', or set SONARQUBE_CLI_TOKEN together with SONARQUBE_CLI_SERVER or SONARQUBE_CLI_ORG.",
    });
  }

  try {
    await authLogin({}, ctx);
  } catch (error) {
    if (error instanceof NoOrganizationMembershipError) {
      return null;
    }
    throw error;
  }
  return resolveFreshAuth();
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
