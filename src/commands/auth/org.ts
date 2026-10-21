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

import { assertOrganizationsSupported } from '@/commands/components/organization/cloud-guard.ts';
import { assertOrganizationMember } from '@/commands/components/organization/select.ts';
import { recordConnectionFromAuth } from '@/core/auth/auth-connection-recorder.ts';
import { ENV_ORG, ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { OrganizationsClient } from '@/core/server/organizations.ts';
import { getActiveConnection } from '@/core/state/state-manager.ts';
import { loadState } from '@/core/state/state-repository.ts';

export async function authOrg(
  org: string | undefined,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  assertNoEnvironmentAuthentication(ctx.auth);
  assertOrganizationsSupported(ctx.auth);
  if (org === undefined) {
    return;
  }

  await assertOrganizationMember(new OrganizationsClient(ctx.connection.httpClient), org);
  if (org === ctx.auth.orgKey) {
    ctx.console.print(`Already using organization: ${org}`);
    return;
  }

  await switchOrganization(ctx.auth, org);
  ctx.console.print(`Switched to organization: ${org}`);
}

async function switchOrganization(auth: ResolvedAuth, org: string): Promise<void> {
  const activeConnection = getActiveConnection(loadState());
  await recordConnectionFromAuth(
    new ResolvedAuth({
      token: auth.token,
      serverUrl: auth.serverUrl,
      orgKey: org,
      connectionType: auth.connectionType,
      source: auth.source,
    }),
    { force: true, tokenName: activeConnection?.tokenName },
  );
}

function assertNoEnvironmentAuthentication(auth: ResolvedAuth): void {
  if (auth.comesFromEnv()) {
    throw new CommandFailedError('Environment variable authentication is already active.', {
      remediationHint: `Set ${ENV_ORG} to the organization you want to use.`,
    });
  }
}
