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

// Organizations command - list organizations the authenticated user can switch into

import { CommandFailedError, type InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolveFormatOption, resolvePageOptions } from '@/core/commands/params.ts';
import { type OrganizationSummary, toOrganizationSummary } from '@/core/domain/organization.ts';
import { errAsync, type ResultAsync } from '@/core/result.ts';
import { type Organization, OrganizationsClient } from '@/core/server/organizations.ts';
import { hasNextPage, type Paging } from '@/core/server/paging.ts';
import { MAX_PAGE_SIZE } from '@/core/server/projects.ts';
import { cyan } from '@/core/ui/colors.ts';
import { padColumns } from '@/core/ui/formatter/column-formatting.ts';

const COLUMN_GAP = 2;

export const VALID_FORMATS = ['json', 'table'] as const;

export interface ListOrgOptions {
  format?: string;
  pageSize: number;
  page: number;
}

export function listOrganizations(
  options: ListOrgOptions,
  ctx: CommandAuthenticatedInvocationContext,
): ResultAsync<void, Error> {
  let format: (typeof VALID_FORMATS)[number];
  try {
    format = resolveFormatOption(options.format, VALID_FORMATS, 'table');
  } catch (err) {
    return errAsync(err as InvalidOptionError);
  }

  return resolvePageOptions(options.pageSize, options.page, MAX_PAGE_SIZE).asyncAndThen(
    (pageOptions) => fetchAndPrintOrganizations(ctx, format, pageOptions),
  );
}

function statusLabel(organization: OrganizationSummary): string {
  if (organization.isActive) {
    return 'active';
  }
  return organization.isAdmin ? 'Admin' : 'Member';
}

function withActiveFirst(organizations: OrganizationSummary[]): OrganizationSummary[] {
  const active = organizations.find((o) => o.isActive);
  if (!active) {
    return organizations;
  }
  return [active, ...organizations.filter((o) => o !== active)];
}

function formatTable(organizations: OrganizationSummary[]): string {
  if (organizations.length === 0) {
    return 'No organizations found';
  }

  const ordered = withActiveFirst(organizations);

  const [nameColumn, keyColumn] = padColumns(
    [ordered.map((o) => o.name), ordered.map((o) => o.key)],
    [],
    COLUMN_GAP,
  );

  return ordered
    .map((organization, i) => {
      const status = statusLabel(organization);
      return `${nameColumn[i]}${keyColumn[i]}${organization.isActive ? cyan(status) : status}`;
    })
    .join('\n');
}

function fetchAndPrintOrganizations(
  ctx: CommandAuthenticatedInvocationContext,
  format: (typeof VALID_FORMATS)[number],
  { pageSize, page }: { pageSize: number; page: number },
): ResultAsync<void, Error> {
  const { auth } = ctx;

  if (auth.connectionType !== 'cloud') {
    return errAsync(
      new CommandFailedError('Organizations are only applicable to SonarQube Cloud connection.'),
    );
  }

  const organizationsClient = new OrganizationsClient(ctx.connection.httpClient);

  return organizationsClient.listUserOrganizations(page, pageSize).map((result) => {
    printOrganizations(ctx, format, result);
  });
}

function printOrganizations(
  ctx: CommandAuthenticatedInvocationContext,
  format: (typeof VALID_FORMATS)[number],
  result: { organizations: Organization[]; paging: Paging },
): void {
  const { auth, console } = ctx;

  const organizations = result.organizations.map((o) => toOrganizationSummary(o, auth.orgKey));

  if (format === 'table') {
    console.print(formatTable(organizations));
    return;
  }

  console.print(
    JSON.stringify({
      organizations,
      paging: { ...result.paging, hasNextPage: hasNextPage(result.paging) },
    }),
  );
}
