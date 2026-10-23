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

import type { IgnoredFile } from './sqaa-changeset.ts';
import type { SqaaProjectGroup, SqaaRunFiles } from './sqaa-types.ts';
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

function displayPathOf(absolutePath: string, displayBase: string): string {
  return toRelativePosixPathOrNull(absolutePath, displayBase) ?? absolutePath;
}

function formatPathList(absolutePaths: string[], displayBase: string): string {
  return absolutePaths.map((p) => '  ' + displayPathOf(p, displayBase)).join('\n');
}

/** Throws one error naming every path outside `projectRoot`, so the user can fix them all at once. */
export function assertInsideProjectRoot(
  absolutePaths: string[],
  projectRoot: string,
  displayBase: string = process.cwd(),
): void {
  const outside = absolutePaths.filter((p) => !isInsideProjectRoot(p, projectRoot));
  if (outside.length === 0) return;
  if (outside.length === 1) {
    throw new InvalidOptionError(
      `File must be inside the project root '${projectRoot}': ${displayPathOf(outside[0], displayBase)}`,
    );
  }
  throw new InvalidOptionError(
    `Files must be inside the project root '${projectRoot}':\n${formatPathList(outside, displayBase)}`,
  );
}

/**
 * Throws when `unmapped` files sit under none of `projectRoots`. A single root keeps the
 * message of {@link assertInsideProjectRoot}; several name every root the files were tried against.
 */
export function assertInsideProjectRoots(
  unmapped: string[],
  projectRoots: string[],
  displayBase: string = process.cwd(),
): void {
  if (unmapped.length === 0) return;
  if (projectRoots.length === 1) {
    assertInsideProjectRoot(unmapped, projectRoots[0], displayBase);
    return;
  }
  throw new InvalidOptionError(
    `Files must be inside one of the project roots (${projectRoots.join(', ')}):\n${formatPathList(unmapped, displayBase)}`,
  );
}

function pathsIgnoredFor(ignored: IgnoredFile[], reason: IgnoredFile['reason']): string[] {
  return ignored.filter((file) => file.reason === reason).map(({ path }) => path);
}

/**
 * An explicitly named file that a run would drop is an input error, unlike the same file in a
 * change set, which is only reported as ignored. A file owned by a project of another connection
 * is refused first: it is never uploaded.
 */
export function assertExplicitFilesAnalyzable(
  ignored: IgnoredFile[],
  projectRoots: string[],
  displayBase: string = process.cwd(),
): void {
  const otherConnection = pathsIgnoredFor(ignored, 'other-connection');
  if (otherConnection.length > 0) {
    throw new InvalidOptionError(
      `Files belong to a project linked to another server or organization than the active connection:\n${formatPathList(otherConnection, displayBase)}`,
    );
  }
  assertInsideProjectRoots(pathsIgnoredFor(ignored, 'outside-project'), projectRoots, displayBase);
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

/** Resolves every path a run needs once, so no caller derives the display views itself. */
export function resolveSqaaRunFiles(groups: SqaaProjectGroup[], displayBase: string): SqaaRunFiles {
  const projects = groups.map(({ projectKey, projectRoot, files }) => ({
    projectKey,
    files: files.map((file) => resolveSqaaPath(file, projectRoot, displayBase)),
  }));
  const displayProjects = projects.map(({ projectKey, files }) => ({
    projectKey,
    paths: files.map((file) => file.displayPath),
  }));
  return {
    projects,
    displayProjects,
    displayPaths: displayProjects.flatMap(({ paths }) => paths),
  };
}

/** The only file of a single-file run, with the project it belongs to. */
export function soleFile({ projects }: SqaaRunFiles): { projectKey: string; file: SqaaPath } {
  const [{ projectKey, files }] = projects;
  return { projectKey, file: files[0] };
}
