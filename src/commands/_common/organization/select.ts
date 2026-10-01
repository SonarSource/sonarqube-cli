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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { discoverOrganization } from '@/core/project-info.ts';
import type { HttpClientError } from '@/core/server/errors.ts';
import {
  type Organization,
  type OrganizationAccess,
  type OrganizationsClient,
} from '@/core/server/organizations.ts';
import type { Paging } from '@/core/server/paging.ts';
import type { Console } from '@/core/ui/console.ts';

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
      remediationHint: 'Check the organization key and your access, then try again.',
    });
  }

  return new CommandFailedError(`Could not verify organization '${org}': ${access.reason}`, {
    remediationHint: 'Check your network connection and the server status, then try again.',
  });
}

/** Fail unless the server can resolve the key. */
export async function assertOrganizationAccessible(
  client: OrganizationsClient,
  org: string,
): Promise<void> {
  const access = await client.resolveOrganizationAccess(org);
  if (access.status !== 'accessible') {
    throw organizationAccessError(org, access);
  }
}

/**
 * Validate organization or get from list
 */
export async function validateOrSelectOrganization(
  client: OrganizationsClient,
  org: string | undefined,
  console: Console,
): Promise<string> {
  if (org) {
    await assertOrganizationAccessible(client, org);
    console.print(`Using organization: ${org}`);
    return org;
  }

  // Try to find organization in project configs first (skip the org listing)
  const configOrg = await discoverOrganization(console);
  if (configOrg) {
    const access = await client.resolveOrganizationAccess(configOrg);
    if (access.status === 'accessible') {
      console.print(`Using organization from config: ${configOrg}`);
      return configOrg;
    }
    // A stale key in a checked-in file cannot be corrected from here, so fall through to the
    // user's memberships rather than failing a command they can still complete. That lookup resolves
    // a single membership without asking anything, so it is worth trying on piped input too.
    if (access.status === 'check_failed') {
      throw organizationAccessError(configOrg, access);
    }
    console.warn(`Organization '${configOrg}' from project config is not accessible.`);
  }

  return await getUserSelectedOrganization(client, console);
}

function organizationRequiredError(): CommandFailedError {
  return new CommandFailedError('Organization key is required.', {
    remediationHint:
      'Provide an organization key explicitly to the command (see --help for syntax), or enter one when prompted.',
  });
}

/**
 * How many keys the user may try before the prompt gives up.
 *
 * A prompt that never yields a usable answer would otherwise loop forever, which turns a stuck
 * terminal — or a test that runs out of queued answers — into a hang instead of an error.
 */
const MAX_ORGANIZATION_ATTEMPTS = 5;

/**
 * Prompt for an organization key until the server resolves one.
 *
 * A typo — or an accidental Enter — is reported and asked again rather than failing the command.
 * Asking again cannot fix an outage, and piped input has nobody to ask, so those still abort on
 * the first rejection.
 */
async function promptForOrganizationKey(
  client: OrganizationsClient,
  console: Console,
): Promise<string> {
  let lastError = organizationRequiredError();

  for (let attempt = 0; attempt < MAX_ORGANIZATION_ATTEMPTS; attempt++) {
    const manualOrg = await console.textPrompt('Enter organization key');
    if (manualOrg === null) {
      throw new CommandFailedError('Organization selection cancelled');
    }
    const org = manualOrg.trim();
    if (!org) {
      lastError = organizationRequiredError();
      if (!process.stdin.isTTY) {
        throw lastError;
      }
      console.warn(lastError.message);
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
    console.warn(lastError.message);
  }

  throw lastError;
}

function listMemberOrganizations(
  client: OrganizationsClient,
): Promise<{ organizations: Organization[]; paging: Paging }> {
  return client.listUserOrganizations().match(
    (result: { organizations: Organization[]; paging: Paging }) => result,
    (error: HttpClientError) => {
      throw new CommandFailedError(`Could not list your organizations: ${error.message}`, {
        remediationHint: 'Check your network connection and the server status, then try again.',
      });
    },
  );
}

async function getUserSelectedOrganization(
  client: OrganizationsClient,
  console: Console,
): Promise<string> {
  // Deduce organization from API: if user is member of exactly one org, use it
  const {
    organizations: memberOrgs,
    paging: { total: orgTotal },
  } = await listMemberOrganizations(client);
  if (memberOrgs.length === 1 && orgTotal === 1) {
    const singleOrg = memberOrgs[0].key;
    console.print(`Using organization (only member): ${singleOrg}`);
    return singleOrg;
  }

  // No org memberships — prompt for manual entry
  if (memberOrgs.length === 0) {
    return promptForOrganizationKey(client, console);
  }

  // Multiple orgs available — let user pick from a list or enter manually
  if (orgTotal > memberOrgs.length) {
    console.print(
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

  const choice = await console.selectPrompt<string>('Select an organization', orgOptions);
  if (choice === null) {
    throw new CommandFailedError('Organization selection cancelled');
  }

  if (choice === MANUAL_ENTRY) {
    return promptForOrganizationKey(client, console);
  }

  return choice;
}
