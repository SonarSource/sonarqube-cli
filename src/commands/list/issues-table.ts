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

import type { SonarQubeIssue } from '@/core/server/types.ts';
import { bold, cyan, gray, red, yellow } from '@/core/ui/colors.ts';

function clean(value: string): string {
  return Bun.stripANSI(value)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitWord(word: string, width: number): string[] {
  const chunks: string[] = [];
  let chunk = '';
  for (const character of word) {
    if (chunk && Bun.stringWidth(chunk + character) > width) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function wrap(value: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of clean(value).split(' ')) {
    for (const chunk of splitWord(word, width)) {
      if (line && Bun.stringWidth(line + ' ' + chunk) > width) {
        lines.push(line);
        line = '';
      }
      line = line ? line + ' ' + chunk : chunk;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function severityColor(severity: SonarQubeIssue['severity']) {
  switch (severity) {
    case 'BLOCKER':
    case 'CRITICAL':
      return red;
    case 'MAJOR':
      return yellow;
    case 'MINOR':
      return cyan;
    case 'INFO':
    default:
      return gray;
  }
}

function location(issue: SonarQubeIssue): string {
  const prefix = issue.project + ':';
  const file = issue.component.startsWith(prefix)
    ? issue.component.slice(prefix.length)
    : issue.component.slice(issue.component.indexOf(':') + 1);
  return `${file}:${issue.line ?? issue.textRange?.startLine ?? '?'}`;
}

export function formatIssuesTable(issues: SonarQubeIssue[], columns?: number): string {
  if (!issues.length) return 'No issues found';
  const terminalColumns = process.stdout.isTTY ? process.stdout.columns : undefined;
  const requested = columns ?? terminalColumns ?? Number(process.env.COLUMNS || 100);
  const width = Number.isFinite(requested)
    ? Math.max(20, Math.min(160, Math.floor(requested)))
    : 100;
  if (width < 60) {
    return issues
      .map((issue) =>
        [
          severityColor(issue.severity)(issue.severity),
          ...wrap(location(issue), width),
          ...wrap(`Rule: ${issue.rule}`, width),
          ...wrap(issue.message, width),
        ].join('\n'),
      )
      .join('\n\n');
  }
  const fileWidth = Math.max(
    9,
    Math.min(28, Math.max(...issues.map((issue) => Bun.stringWidth(clean(location(issue)))))),
  );
  const ruleWidth = Math.max(
    4,
    Math.min(24, Math.max(...issues.map((issue) => Bun.stringWidth(clean(issue.rule))))),
  );
  const widths = [8, fileWidth, ruleWidth];
  if (width - widths.reduce((sum, value) => sum + value, 0) - 6 < 20) {
    const budget = width - 8 - 6 - 20;
    widths[1] = Math.min(fileWidth, Math.max(9, Math.floor(budget * 0.6)));
    widths[2] = Math.min(ruleWidth, budget - widths[1]);
  }
  widths.push(width - widths.reduce((sum, value) => sum + value, 0) - 6);
  const pad = (value: string, size: number) =>
    value + ' '.repeat(Math.max(0, size - Bun.stringWidth(value)));
  const headings = ['SEVERITY', 'FILE:LINE', 'RULE', 'MESSAGE'];
  const lines = [
    bold(
      headings
        .map((heading, i) => pad(heading, widths[i]))
        .join('  ')
        .trimEnd(),
    ),
    gray('─'.repeat(width)),
  ];
  for (const issue of issues) {
    const cells = [issue.severity, location(issue), issue.rule, issue.message].map((value, i) =>
      wrap(value, widths[i]),
    );
    const rows = Math.max(...cells.map((cell) => cell.length));
    for (let row = 0; row < rows; row++) {
      const values = cells.map((cell, i) => pad(cell[row] ?? '', widths[i]));
      values[0] = severityColor(issue.severity)(values[0]);
      lines.push(values.join('  ').trimEnd());
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
