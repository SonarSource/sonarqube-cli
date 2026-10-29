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

/** A finding as the public API returns it; detail fields are kept as returned. */
export interface ProjectFinding extends Record<string, unknown> {
  id: string;
  projectId: string;
  category: FindingCategory;
  message?: string;
}
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
  const finding = value as Record<string, unknown>;
  if (typeof finding.id !== 'string' || !finding.id || typeof finding.projectId !== 'string')
    throw new CommandFailedError('Public finding response has an invalid id or project.');
  if (!(FINDING_CATEGORIES as readonly unknown[]).includes(finding.category))
    throw new CommandFailedError(`Public finding ${finding.id} has an unsupported category.`);
  if (finding.message != null && typeof finding.message !== 'string')
    throw new CommandFailedError(`Public finding ${finding.id} message must be a string.`);
  return finding as ProjectFinding;
}
