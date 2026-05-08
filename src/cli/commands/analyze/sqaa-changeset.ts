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

// Resolves the set of local files to analyze from Git, honouring .gitignore.

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { spawnProcess } from '../../../lib/process';
import { CommandFailedError } from '../_common/error';

/** Maximum byte size per file sent to SQAA. Files exceeding this are skipped. */
export const SQAA_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface ChangeSetOptions {
  /** Staged files only (`--staged`). */
  staged?: boolean;
  /** Diff against this branch/ref (`--base <ref>`). */
  base?: string;
}

/** A file excluded from analysis with the reason it was skipped. */
export interface IgnoredFile {
  path: string;
  reason: 'binary' | 'oversized';
}

/** Result of resolving a change set: files to analyze and files silently ignored. */
export interface ChangeSetResult {
  files: string[];
  ignored: IgnoredFile[];
  /** Repository root used to resolve git output. Useful for computing relative paths. */
  repoRoot: string;
}

/**
 * Resolves the list of absolute file paths that belong to the local change set,
 * filtering out git-ignored paths and binary files, capped at SQAA_MAX_FILE_BYTES per file.
 *
 * All git commands are run from the repository top-level (resolved via
 * `git rev-parse --show-toplevel`), so behavior is identical whether the user
 * runs from the repo root or a subdirectory. Returned paths are absolute.
 *
 * Modes:
 *   - Default (no options): `git diff HEAD` (staged + unstaged) + untracked non-ignored files
 *   - staged=true:          `git diff --cached` (staged only)
 *   - base=<ref>:           `git diff <ref>` + untracked non-ignored files
 */
export async function resolveChangeSet(
  cwd: string,
  options: ChangeSetOptions = {},
): Promise<ChangeSetResult> {
  const { staged, base } = options;

  const repoRoot = await resolveRepoRoot(cwd);

  const diffFiles = await getDiffFiles(repoRoot, { staged, base });
  const untrackedFiles = staged ? [] : await getUntrackedNonIgnoredFiles(repoRoot);
  const absolute = [...diffFiles, ...untrackedFiles].map((f) => join(repoRoot, f));

  const { files: nonBinary, ignored: binaryIgnored } = partitionBinary(absolute);
  const { files, ignored: oversizedIgnored } = partitionBySize(nonBinary);

  return { files, ignored: [...binaryIgnored, ...oversizedIgnored], repoRoot };
}

/**
 * Resolve the absolute path of the repository top-level for `cwd`.
 * Throws CommandFailedError when `cwd` is not inside a Git repository.
 */
async function resolveRepoRoot(cwd: string): Promise<string> {
  const out = await runGit(['rev-parse', '--show-toplevel'], cwd);
  return resolve(out.trim());
}

async function getDiffFiles(
  cwd: string,
  opts: { staged?: boolean; base?: string },
): Promise<string[]> {
  // -z: NUL-separated output, no path quoting — robust against unusual filenames
  // (leading/trailing whitespace, newlines, non-ASCII bytes with core.quotePath=true).
  const args: string[] = ['diff', '--name-only', '--diff-filter=ACMR', '-z'];

  if (opts.staged) {
    args.push('--cached');
  } else if (opts.base) {
    args.push(opts.base);
  } else {
    args.push('HEAD');
  }

  const result = await runGit(args, cwd);
  return parseNulSeparated(result);
}

async function getUntrackedNonIgnoredFiles(cwd: string): Promise<string[]> {
  const result = await runGit(['ls-files', '-z', '--others', '--exclude-standard'], cwd);
  return parseNulSeparated(result);
}

async function runGit(args: string[], cwd: string): Promise<string> {
  let result;
  try {
    result = await spawnProcess('git', args, { cwd });
  } catch (err) {
    throw new CommandFailedError(`Failed to run git: ${(err as Error).message}`);
  }
  if (result.exitCode !== 0) {
    throw new CommandFailedError(
      `git ${args[0]} failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }
  return result.stdout;
}

function parseNulSeparated(output: string): string[] {
  return output.split('\0').filter((p) => p.length > 0);
}

/**
 * Separates binary files from text files.
 * Heuristic: reads the first 8 KB; a NUL byte indicates binary content.
 */
function partitionBinary(files: string[]): { files: string[]; ignored: IgnoredFile[] } {
  const kept: string[] = [];
  const ignored: IgnoredFile[] = [];
  for (const f of files) {
    try {
      const buf = Buffer.alloc(8192);
      const fd = openSync(f, 'r');
      try {
        const bytesRead = readSync(fd, buf, 0, buf.length, 0);
        if (buf.subarray(0, bytesRead).includes(0x00)) {
          ignored.push({ path: f, reason: 'binary' });
        } else {
          kept.push(f);
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // Unreadable files are silently skipped (e.g. permission errors, deleted between stat and read).
    }
  }
  return { files: kept, ignored };
}

/** Separates files that exceed the per-file size limit. */
function partitionBySize(files: string[]): { files: string[]; ignored: IgnoredFile[] } {
  const kept: string[] = [];
  const ignored: IgnoredFile[] = [];
  for (const f of files) {
    try {
      if (statSync(f).size <= SQAA_MAX_FILE_BYTES) {
        kept.push(f);
      } else {
        ignored.push({ path: f, reason: 'oversized' });
      }
    } catch {
      // Silently skip files that can't be stated.
    }
  }
  return { files: kept, ignored };
}
