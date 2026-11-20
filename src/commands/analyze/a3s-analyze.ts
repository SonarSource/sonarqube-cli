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

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';

import { runContextPassthrough } from '../context/index.ts';
import type { AnalyzeSqaaOptions } from './sqaa-types.ts';

const DEFAULT_FORMAT = 'text';

export function buildA3sAnalyzeArgs(options: AnalyzeSqaaOptions): string[] {
  const args: string[] = [];
  for (const file of options.file ?? []) {
    args.push('--file', file);
  }
  if (options.staged) args.push('--staged');
  if (options.base !== undefined) args.push('--base', options.base);
  if (options.branch !== undefined) args.push('--branch', options.branch);
  if (options.project !== undefined) args.push('--project', options.project);
  if (options.depth !== undefined) args.push('--depth', options.depth);
  if (options.force) args.push('--force');
  if (options.format !== undefined && options.format !== DEFAULT_FORMAT) {
    args.push('--format', options.format);
  }
  return args;
}

export async function runA3sAnalyze(
  options: AnalyzeSqaaOptions,
  ctx: CommandInvocationContext,
): Promise<void> {
  await runContextPassthrough('analyze', buildA3sAnalyzeArgs(options), { ctx });
}
