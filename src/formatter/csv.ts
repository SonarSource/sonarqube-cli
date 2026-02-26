/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// CSV formatter

import type { SonarQubeIssue } from '../lib/types.js';

function escapeCSV(value: string | number | undefined): string {
  if (value === undefined) {
    return '';
  }

  const str = String(value);

  // If contains comma, quote, or newline - wrap in quotes and escape quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replaceAll('"', '""')}"`;
  }

  return str;
}

export function formatCSV(issues: SonarQubeIssue[]): string {
  const lines: string[] = [];

  // Header
  lines.push('severity,rule,message,file,line,type,status');

  // Rows
  for (const issue of issues) {
    const file = issue.component.split(':').pop() || issue.component;
    const row = [
      escapeCSV(issue.severity),
      escapeCSV(issue.rule),
      escapeCSV(issue.message),
      escapeCSV(file),
      escapeCSV(issue.line),
      escapeCSV(issue.type),
      escapeCSV(issue.status),
    ].join(',');
    lines.push(row);
  }

  return lines.join('\n');
}
