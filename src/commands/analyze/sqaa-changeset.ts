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
import { join } from 'node:path';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { resolveCurrentGitBranch, resolveGitBranchAtRepoRoot } from '@/core/host/git/branch.ts';
import { resolveGitRepoRoot } from '@/core/host/git/worktree.ts';
import { canonicalizePath, isAncestorOrSelf } from '@/core/io/fs-utils.ts';
import { spawnProcessCapturingBytes, spawnProcessWithTimeout } from '@/core/process/process.ts';

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
  reason: 'binary' | 'oversized' | 'outside-repository' | 'outside-project' | 'other-connection';
}

/** Result of resolving a change set: files to analyze and files silently ignored. */
export interface ChangeSetResult {
  files: string[];
  stagedContents?: ReadonlyMap<string, string>;
  ignored: IgnoredFile[];
  /** Repository root used to resolve git output. Useful for computing relative paths. */
  repoRoot: string;
}

/** SQAA paths are relative to a project root, so a file no project of the connection owns cannot be analyzed. */
export function excludeIgnoredFiles(
  changeSet: ChangeSetResult,
  ignored: IgnoredFile[],
): ChangeSetResult {
  const excluded = new Set(ignored.map(({ path }) => path));
  return {
    ...changeSet,
    files: changeSet.files.filter((file) => !excluded.has(file)),
    ignored: [...changeSet.ignored, ...ignored],
  };
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
 *   - Default (no options): `git diff HEAD` (or the unborn index) + untracked non-ignored files
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
  if (staged) return resolveStagedContents(repoRoot, diffFiles);
  const untrackedFiles = await getUntrackedNonIgnoredFiles(repoRoot);
  const absolute = [...diffFiles, ...untrackedFiles].map((f) => join(repoRoot, f));
  const inRepo: string[] = [];
  const outsideIgnored: IgnoredFile[] = [];
  for (const file of absolute) {
    if (isAncestorOrSelf(repoRoot, canonicalizePath(file))) {
      inRepo.push(file);
    } else {
      outsideIgnored.push({ path: file, reason: 'outside-repository' });
    }
  }

  const { files: nonBinary, ignored: binaryIgnored } = partitionBinary(inRepo);
  const { files, ignored: oversizedIgnored } = partitionBySize(nonBinary);

  return { files, ignored: [...outsideIgnored, ...binaryIgnored, ...oversizedIgnored], repoRoot };
}

async function resolveStagedContents(repoRoot: string, paths: string[]): Promise<ChangeSetResult> {
  const stagedContents = new Map<string, string>();
  const ignored: IgnoredFile[] = [];
  const entries = await resolveStagedEntries(repoRoot, paths);
  const concurrency = 8;
  const captureBatch = async (offset: number): Promise<void> => {
    const snapshots = await Promise.all(
      entries
        .slice(offset, offset + concurrency)
        .map((entry) => readStagedContent(repoRoot, entry)),
    );
    for (const { path, content } of snapshots) {
      if (!content) {
        ignored.push({ path, reason: 'oversized' });
      } else if (content.subarray(0, 8192).includes(0)) {
        ignored.push({ path, reason: 'binary' });
      } else {
        stagedContents.set(path, content.toString('utf8'));
      }
    }
    if (offset + concurrency < entries.length) await captureBatch(offset + concurrency);
  };
  await captureBatch(0);
  return { files: [...stagedContents.keys()], ignored, repoRoot, stagedContents };
}

interface StagedEntry {
  path: string;
  objectId: string;
  size: number;
}

async function resolveStagedEntries(repoRoot: string, paths: string[]): Promise<StagedEntry[]> {
  const selected = new Set(paths);
  const index = await runGit(['ls-files', '--stage', '-z'], repoRoot);
  const entries = parseNulSeparated(index).flatMap((entry) => {
    const separator = entry.indexOf('\t');
    const [mode, objectId, stage] = entry.slice(0, separator).split(' ');
    const path = entry.slice(separator + 1);
    if (stage !== '0' || !selected.has(path) || (mode !== '100644' && mode !== '100755')) return [];
    return [{ path, objectId }];
  });
  if (entries.length === 0) return [];
  const output = await runGit(
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    repoRoot,
    [0],
    entries.map(({ objectId }) => objectId).join('\n') + '\n',
  );
  const sizes = new Map(
    output
      .trim()
      .split('\n')
      .map((line) => {
        const [objectId, type, sizeText] = line.split(' ');
        const size = Number(sizeText);
        if (type !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
          throw new CommandFailedError('Could not inspect staged blob sizes.');
        }
        return [objectId, size] as const;
      }),
  );
  return entries.map((entry) => {
    const size = sizes.get(entry.objectId);
    if (size === undefined) throw new CommandFailedError('Missing staged blob size.');
    return { ...entry, size };
  });
}

async function readStagedContent(
  repoRoot: string,
  entry: StagedEntry,
): Promise<{ path: string; content?: Buffer }> {
  const path = join(repoRoot, entry.path);
  if (entry.size > SQAA_MAX_FILE_BYTES) return { path };
  const result = await spawnProcessCapturingBytes(
    'git',
    ['cat-file', 'blob', entry.objectId],
    { cwd: repoRoot },
    GIT_COMMAND_TIMEOUT_MS,
    'Reading staged content timed out',
  );
  if (result.exitCode !== 0) {
    throw new CommandFailedError(`Could not read staged content for ${entry.path}.`);
  }
  return { path, content: result.stdout };
}

/** Explicit `--branch` wins; otherwise auto-detect from git when possible. */
export async function resolveSqaaBranch(
  explicitBranch: string | undefined,
  contextPath: string = process.cwd(),
): Promise<string | undefined> {
  return explicitBranch ?? (await resolveCurrentGitBranch(contextPath));
}

/** Same as {@link resolveSqaaBranch}, but for an already-resolved repository root. */
export async function resolveSqaaBranchAtRepoRoot(
  explicitBranch: string | undefined,
  repoRoot: string,
): Promise<string | undefined> {
  return explicitBranch ?? (await resolveGitBranchAtRepoRoot(repoRoot));
}

/**
 * Resolve the absolute path of the repository top-level for `cwd`.
 * Throws CommandFailedError when `cwd` is not inside a Git repository.
 */
async function resolveRepoRoot(cwd: string): Promise<string> {
  const root = await resolveGitRepoRoot(cwd);
  if (!root) {
    throw new CommandFailedError('Not inside a git repository.', {
      remediationHint:
        'Ensure git is installed and available on PATH, then retry from a git repository.',
    });
  }
  return root;
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
    const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd, [0, 1]);
    args.push(head.trim() ? 'HEAD' : '--cached');
  }

  const result = await runGit(args, cwd);
  return parseNulSeparated(result);
}

async function getUntrackedNonIgnoredFiles(cwd: string): Promise<string[]> {
  const result = await runGit(['ls-files', '-z', '--others', '--exclude-standard'], cwd);
  return parseNulSeparated(result);
}

const GIT_COMMAND_TIMEOUT_MS = 15_000;

async function runGit(
  args: string[],
  cwd: string,
  acceptedExitCodes: number[] = [0],
  stdinData?: string,
): Promise<string> {
  let result;
  try {
    result = await spawnProcessWithTimeout(
      'git',
      args,
      { cwd, stdin: stdinData === undefined ? 'ignore' : 'pipe', stdinData },
      GIT_COMMAND_TIMEOUT_MS,
      `git ${args[0] ?? 'command'} timed out`,
    );
  } catch (err) {
    throw new CommandFailedError(`Failed to run git: ${(err as Error).message}`, {
      remediationHint:
        'Ensure git is installed and available on PATH, then retry from a git repository.',
    });
  }
  if (result.exitCode === null || !acceptedExitCodes.includes(result.exitCode)) {
    throw new CommandFailedError(
      `git ${args[0]} failed (exit ${result.exitCode}): ${result.stderr}`,
      {
        remediationHint:
          'Ensure git is installed and available on PATH, then retry from a git repository.',
      },
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
