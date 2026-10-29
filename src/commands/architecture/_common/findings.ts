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

export const DEFAULT_FINDINGS_PAGE_SIZE = 50;
export const FINDING_CATEGORIES = ['DEVIATION', 'FLAW', 'SMELL'] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export class FindingNotFoundError extends CommandFailedError {}

export interface ProjectFinding {
  id: string;
  projectId: string;
  category: FindingCategory;
  message?: string;
  components?: string[];
  relationships?: { from: string; to: string }[];
  constraint?: string;
  measures?: Record<string, number>;
}
const DETAIL_FIELDS = ['message', 'components', 'relationships', 'constraint', 'measures'] as const;
export interface FindingPage {
  findings: ProjectFinding[];
  page: { pageIndex: number; pageSize: number; total: number };
}
export interface FindingsApi {
  getFindingsPage(
    category: FindingCategory | undefined,
    pageIndex: number,
    pageSize: number,
  ): Promise<FindingPage>;
  getFinding(id: string): Promise<ProjectFinding>;
}

export function parseProjectFinding(value: unknown): ProjectFinding {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CommandFailedError('Each finding must be an object.');
  const object = value as Record<string, unknown>;
  if (
    typeof object.id !== 'string' ||
    !object.id.trim() ||
    typeof object.projectId !== 'string' ||
    !object.projectId.trim()
  )
    throw new CommandFailedError('Public finding response has an invalid id or project.');
  if (!(FINDING_CATEGORIES as readonly unknown[]).includes(object.category))
    throw new CommandFailedError(`Public finding ${object.id} has an unsupported category.`);
  if (object.message != null && typeof object.message !== 'string')
    throw new CommandFailedError(`Public finding ${object.id} message must be a string.`);
  if (object.components != null && !isStringArray(object.components))
    throw new CommandFailedError(`Public finding ${object.id} components must be strings.`);
  if (object.relationships != null && !isRelationshipArray(object.relationships))
    throw new CommandFailedError(`Public finding ${object.id} has invalid relationships.`);
  if (object.constraint != null && typeof object.constraint !== 'string')
    throw new CommandFailedError(`Public finding ${object.id} constraint must be a string.`);
  if (
    object.measures != null &&
    (typeof object.measures !== 'object' ||
      Array.isArray(object.measures) ||
      Object.values(object.measures).some((value) => typeof value !== 'number'))
  )
    throw new CommandFailedError(`Public finding ${object.id} has a non-numeric measure.`);
  const finding = {
    id: object.id,
    projectId: object.projectId,
    category: object.category,
  } as ProjectFinding;
  for (const name of DETAIL_FIELDS)
    if (object[name] != null) Object.assign(finding, { [name]: object[name] });
  return finding;
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRelationshipArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).from === 'string' &&
        typeof (item as Record<string, unknown>).to === 'string',
    )
  );
}

export function findingId(value: string): string {
  if (!value.trim() || value === '.' || value === '..')
    throw new CommandFailedError('Finding id must be a nonempty id.');
  return value;
}
