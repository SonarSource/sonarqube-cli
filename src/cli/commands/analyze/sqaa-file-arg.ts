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

// Parse `--file path[:MAIN|TEST]` arguments for SQAA.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { SqaaFileScope } from '../../../sonarqube/client';
import { InvalidOptionError } from '../_common/error.js';

const VALID_SCOPES = new Set<SqaaFileScope>(['MAIN', 'TEST']);

export interface ParsedSqaaFileArg {
  path: string;
  scope?: SqaaFileScope;
}

export interface ResolvedSqaaFileEntry {
  absolutePath: string;
  scope?: SqaaFileScope;
}

/** Commander collector for repeatable `--file` options. */
export function collectSqaaFileOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/**
 * Parse a single `--file` value. Scope is recognized only when the suffix after
 * the last `:` is exactly `MAIN` or `TEST` (literal colons in paths are unsupported).
 */
export function parseSqaaFileArg(raw: string): ParsedSqaaFileArg {
  const colonIndex = raw.lastIndexOf(':');
  if (colonIndex > 0) {
    const suffix = raw.slice(colonIndex + 1);
    if (VALID_SCOPES.has(suffix as SqaaFileScope)) {
      return { path: raw.slice(0, colonIndex), scope: suffix as SqaaFileScope };
    }
  }
  return { path: raw };
}

export function resolveSqaaFileArgs(
  rawArgs: string[],
  cwd: string = process.cwd(),
): ResolvedSqaaFileEntry[] {
  const seenAbsolute = new Set<string>();
  const entries: ResolvedSqaaFileEntry[] = [];

  for (const raw of rawArgs) {
    const { path, scope } = parseSqaaFileArg(raw);
    const absolutePath = resolve(cwd, path);
    if (seenAbsolute.has(absolutePath)) {
      throw new InvalidOptionError(`Duplicate --file entry: ${path}`);
    }
    seenAbsolute.add(absolutePath);
    if (!existsSync(absolutePath)) {
      throw new InvalidOptionError(`File not found: ${path}`);
    }
    entries.push({ absolutePath, scope });
  }

  return entries;
}
