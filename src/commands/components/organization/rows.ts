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

import type { OrganizationSummary } from '@/core/domain/organization.ts';
import { cyan } from '@/core/ui/colors.ts';
import { padColumns } from '@/core/ui/formatter/column-formatting.ts';

const COLUMN_GAP = 2;

export interface OrganizationRow {
  key: string;
  text: string;
}

/** Rows come back in display order: the active organization first, the rest as given. */
export function formatOrganizationRows(organizations: OrganizationSummary[]): OrganizationRow[] {
  const ordered = withActiveFirst(organizations);

  const [nameColumn, keyColumn] = padColumns(
    [ordered.map((o) => o.name), ordered.map((o) => o.key)],
    [],
    COLUMN_GAP,
  );

  return ordered.map((organization, i) => {
    const status = statusLabel(organization);
    const styledStatus = organization.isActive ? cyan(status) : status;
    return { key: organization.key, text: `${nameColumn[i]}${keyColumn[i]}${styledStatus}` };
  });
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
