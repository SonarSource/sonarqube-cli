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

import { encode as encodeToToon } from '@toon-format/toon';

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';

import type { Ecosystem } from './architecture-api.ts';

export const ARCHITECTURE_FORMATS = ['toon', 'json'] as const;
export type ArchitectureFormat = (typeof ARCHITECTURE_FORMATS)[number];
/** The read commands also have a text form, their default on a terminal. */
export const TEXT_FORMATS = ['text', ...ARCHITECTURE_FORMATS] as const;

export interface ArchitectureReadOptions {
  project?: string;
  component?: string;
  depth?: number;
  language?: Ecosystem;
  format?: string;
}

export function defaultTextFormat(): (typeof TEXT_FORMATS)[number] {
  return process.stdout.isTTY || process.env.SONARQUBE_CLI_MOCK_TTY ? 'text' : 'toon';
}

export function resolveDepth(options: ArchitectureReadOptions, defaultDepth: number): number {
  if (options.depth === undefined) return defaultDepth;
  if (!Number.isInteger(options.depth) || options.depth < 1) {
    throw new InvalidOptionError(
      `Invalid --depth option: '${options.depth}'. Must be an integer >= 1`,
    );
  }
  return options.depth;
}

export function printPayload(
  ctx: CommandAuthenticatedInvocationContext,
  format: ArchitectureFormat,
  payload: Record<string, unknown>,
): void {
  ctx.console.print(format === 'json' ? JSON.stringify(payload, null, 2) : encodeToToon(payload));
}
