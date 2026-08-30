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

// Table formatter for terminal output

import type { SonarQubeIssue } from '@/core/server/types.ts';

import { columnFormatting } from './column-formatting.ts';

const MIN_SEVERITY_WIDTH = 8;
const MIN_RULE_WIDTH = 15;
const MIN_MESSAGE_WIDTH = 50;

export function formatTable(issues: SonarQubeIssue[]): string {
  if (issues.length === 0) {
    return 'No issues found';
  }

  const [severityWidth, ruleWidth, messageWidth] = columnFormatting(
    [issues.map((i) => i.severity), issues.map((i) => i.rule), issues.map((i) => i.message)],
    [MIN_SEVERITY_WIDTH, MIN_RULE_WIDTH, MIN_MESSAGE_WIDTH],
  );

  // Header
  const header = [
    'SEVERITY'.padEnd(severityWidth),
    'RULE'.padEnd(ruleWidth),
    'MESSAGE'.padEnd(messageWidth),
    'FILE',
  ].join(' | ');

  const separator = '-'.repeat(header.length);

  const lines = [header, separator];

  // Rows
  for (const issue of issues) {
    const file = issue.component.split(':').pop() || issue.component;
    const line = [
      issue.severity.padEnd(severityWidth),
      issue.rule.padEnd(ruleWidth),
      issue.message.substring(0, messageWidth).padEnd(messageWidth),
      `${file}:${issue.line || '?'}`,
    ].join(' | ');
    lines.push(line);
  }

  return lines.join('\n');
}
