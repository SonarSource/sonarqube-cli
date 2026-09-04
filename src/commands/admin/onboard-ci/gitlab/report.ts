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

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CommandFailedError } from '@/core/command-error.ts';
import type { Console } from '@/core/ui/console.ts';

import type { DryRunResults, OnboardCiResults } from './types.ts';

export function writeReportFile(
  results: OnboardCiResults | DryRunResults,
  filename: string,
  console: Console,
): void {
  const dest = join(process.cwd(), filename);
  try {
    writeFileSync(dest, JSON.stringify(results, null, 2), 'utf8');
  } catch (err) {
    throw new CommandFailedError(`Failed to write report to ${dest}: ${String(err)}`);
  }
  console.print(`Full report: ${filename}  (written to current directory)`);
}
