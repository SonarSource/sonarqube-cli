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

import type {
  AnalyzeProjectIssue,
  AnalyzeProjectRelease,
  AnalyzeProjectResponse,
} from './sca-scanner.ts';

const RESOLVED_STATUSES = new Set(['SAFE', 'FIXED', 'ACCEPT']);

const SEVERITY_RANK: Record<string, number> = {
  BLOCKER: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};

const TYPE_RANK: Record<string, number> = {
  MALWARE: 0,
  PROHIBITED_LICENSE: 1,
  VULNERABILITY: 2,
};

export type DependencyRisksStatusFilter = 'all' | 'open';

export function applyStatusFilter(
  response: AnalyzeProjectResponse,
  statusFilter: DependencyRisksStatusFilter,
): AnalyzeProjectResponse {
  let releases = response.releases.filter((release) => release.issues.length > 0);
  if (statusFilter === 'open') {
    releases = filterOutResolved(releases);
  }
  return { ...response, releases };
}

function filterOutResolved(releases: AnalyzeProjectRelease[]) {
  return releases
    .map((release) => ({
      ...release,
      issues: release.issues.filter((issue) => !isResolved(issue.status)),
    }))
    .filter((release) => release.issues.length > 0);
}

export function countUnresolvedIssues(response: AnalyzeProjectResponse): number {
  let count = 0;
  for (const release of response.releases) {
    for (const issue of release.issues) {
      if (!isResolved(issue.status)) count += 1;
    }
  }
  return count;
}

export function sortReleases(releases: AnalyzeProjectRelease[]): AnalyzeProjectRelease[] {
  return [...releases]
    .map((release) => ({ ...release, issues: sortIssues(release.issues) }))
    .sort((a, b) => packageLabel(a).localeCompare(packageLabel(b)));
}

function packageLabel(release: AnalyzeProjectRelease): string {
  return `${release.packageName}@${release.version}`;
}

function sortIssues(issues: AnalyzeProjectIssue[]): AnalyzeProjectIssue[] {
  return [...issues].sort((a, b) => {
    const typeDiff = typeRank(a.type) - typeRank(b.type);
    if (typeDiff !== 0) return typeDiff;
    return severityRank(a.severity) - severityRank(b.severity);
  });
}

function typeRank(type: string): number {
  return TYPE_RANK[type] ?? Number.MAX_SAFE_INTEGER;
}

function severityRank(severity: string | undefined): number {
  return severity
    ? (SEVERITY_RANK[severity.toUpperCase()] ?? Number.MAX_SAFE_INTEGER)
    : Number.MAX_SAFE_INTEGER;
}

function isResolved(status: string | null): boolean {
  return status !== null && RESOLVED_STATUSES.has(status.toUpperCase());
}
