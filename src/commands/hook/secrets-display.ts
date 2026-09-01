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

import type { SecretsJsonIssue } from '@/commands/analyze/secrets.ts';
import type { Console } from '@/core/ui/console.ts';
import { TerminalConsole } from '@/core/ui/terminal-console.ts';
function formatSecretsFindingLine(issue: SecretsJsonIssue): string {
  const location = issue.location ? `:${String(issue.location.startLine)}` : '';
  const secret = issue.maskedSecret ? ` (secret: ${issue.maskedSecret})` : '';
  return `  • ${issue.file ?? '(unknown)'}${location} — ${issue.description}${secret}`;
}

/** Shared by the git pre-commit/pre-push hooks to surface finding detail before blocking. */
export function printSecretsFindingsOrStderr(
  issues: SecretsJsonIssue[],
  stderr: string,
  console: Console = new TerminalConsole(),
): void {
  if (issues.length > 0) {
    console.print(issues.map(formatSecretsFindingLine).join('\n'));
  } else if (stderr) {
    console.print(stderr);
  }
}
