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

import { resolveFormatOption } from '@/core/commands/params.ts';
import type { Paging } from '@/core/server/paging.ts';
import type { SonarQubeIssue } from '@/core/server/types.ts';
import { bold, green, red, yellow } from '@/core/ui/colors.ts';
import type { Console } from '@/core/ui/console.ts';

import { formatIssuesTable } from '../list/issues-table.ts';

export const ONBOARD_FORMATS = ['text', 'json'] as const;
export const ONBOARD_ISSUES_PAGE_SIZE = 20;

export interface OnboardReport {
  projectKey: string;
  projectName: string;
  analysis:
    | { status: 'completed'; id: string }
    | { status: 'skipped'; id: null }
    | { status: 'detached'; id: null; pid: number; statusPath: string };
  qualityGate: string | null;
  dashboardUrl: string;
  issues: SonarQubeIssue[] | null;
  paging: Paging | null;
  scannerLogPath: string | null;
  scannerOutput?: { stdout: string; stderr: string };
  messages: string[];
  warnings: string[];
}

export function resolveOnboardFormat(raw?: string): 'text' | 'json' {
  return resolveFormatOption(raw, ONBOARD_FORMATS, 'text');
}

function qualityGateLabel(status: string | null): string {
  switch (status) {
    case 'OK':
      return green('Passed');
    case 'ERROR':
      return red('Failed');
    case 'WARN':
      return yellow('Warning');
    case 'NONE':
      return 'Not computed';
    case null:
    default:
      return 'Unavailable';
  }
}

export function printOnboardReport(
  report: OnboardReport,
  format: 'text' | 'json',
  console: Console,
): void {
  if (format === 'json') {
    console.print(JSON.stringify(report, null, 2));
    return;
  }
  if (report.analysis.status === 'skipped') {
    console.print(`Project dashboard: ${report.dashboardUrl}`);
    return;
  }
  if (report.analysis.status === 'detached') {
    console.print(
      [
        `Analysis running in background (PID ${report.analysis.pid}).`,
        `Project: ${report.projectKey}`,
        `Scanner log: ${report.scannerLogPath}`,
        `Analysis status: ${report.analysis.statusPath}`,
        `Full results: ${report.dashboardUrl}`,
      ].join('\n'),
    );
    return;
  }
  const total = report.paging?.total;
  const lines = [
    green('✓') + ' ' + bold(`Analysis complete — ${report.projectName}`),
    '',
    `  Project        ${report.projectKey}`,
    `  Quality gate   ${qualityGateLabel(report.qualityGate)}`,
    `  Active issues  ${total ?? 'Unavailable'}`,
    `  Full results   ${report.dashboardUrl}`,
    '',
  ];
  if (report.issues) {
    lines.push(formatIssuesTable(report.issues));
    if (total !== undefined && total > 0) {
      lines.push('', `Showing ${report.issues.length} of ${total} active issues.`);
    }
    if (report.paging && report.paging.pageIndex * report.paging.pageSize < report.paging.total) {
      lines.push(
        `More: sonar list issues --project=${report.projectKey} --format table --page-size ${report.paging.pageSize} --page ${report.paging.pageIndex + 1}`,
      );
    }
  } else {
    lines.push('Issues could not be loaded. View full results using the link above.');
  }
  console.print(lines.join('\n'));
}
