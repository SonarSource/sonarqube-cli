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

// Path handling for SQAA: display paths for users, server paths relative to the project root

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { toRelativePosixPath as toRelativePosixPathOrNull } from '@/core/io/fs-utils.ts';

import type { SqaaIssue } from './sqaa-wire-types.ts';

/**
 * Throwing wrapper over `core/io/fs-utils.toRelativePosixPath`.
 * Throws when `file` is outside `base` (traversal) or on a different drive.
 */
export function toRelativePosixPath(file: string, base: string = process.cwd()): string {
  const rel = toRelativePosixPathOrNull(file, base);
  if (rel == null) {
    throw new InvalidOptionError(`File must be inside '${base}': ${file}`);
  }
  return rel;
}

export interface SqaaPath {
  absolutePath: string;
  /** Relative to `displayBase`; what the user sees in reports. */
  displayPath: string;
  /** Relative to the project root, which is what SQAA matches against the project's analysis. */
  serverPath: string;
}

export function isInsideProjectRoot(absolutePath: string, projectRoot: string): boolean {
  return toRelativePosixPathOrNull(absolutePath, projectRoot) !== null;
}

/** Throws one error naming every path outside `projectRoot`, so the user can fix them all at once. */
export function assertInsideProjectRoot(
  absolutePaths: string[],
  projectRoot: string,
  displayBase: string = process.cwd(),
): void {
  const outside = absolutePaths
    .filter((p) => !isInsideProjectRoot(p, projectRoot))
    .map((p) => toRelativePosixPathOrNull(p, displayBase) ?? p);
  if (outside.length === 0) return;
  if (outside.length === 1) {
    throw new InvalidOptionError(
      `File must be inside the project root '${projectRoot}': ${outside[0]}`,
    );
  }
  const list = outside.map((p) => '  ' + p).join('\n');
  throw new InvalidOptionError(`Files must be inside the project root '${projectRoot}':\n${list}`);
}

/** Throws when `absolutePath` is outside `projectRoot` or `displayBase`. */
export function resolveSqaaPath(
  absolutePath: string,
  projectRoot: string,
  displayBase: string = process.cwd(),
): SqaaPath {
  const serverPath = toRelativePosixPathOrNull(absolutePath, projectRoot);
  if (serverPath == null) {
    throw new InvalidOptionError(
      `File must be inside the project root '${projectRoot}': ${absolutePath}`,
    );
  }
  return {
    absolutePath,
    displayPath: toRelativePosixPath(absolutePath, displayBase),
    serverPath,
  };
}

/** SQAA echoes the `serverPath` it was sent; reports show the `displayPath` instead. */
export function withDisplayFilePath(issues: SqaaIssue[], displayPath: string): SqaaIssue[] {
  return issues.map((issue) => ({ ...issue, filePath: displayPath }));
}
