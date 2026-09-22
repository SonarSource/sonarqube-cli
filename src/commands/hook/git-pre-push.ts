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

// git pre-push callback handler — scans files in new commits for secrets.
// Replaces the shell logic that was previously embedded in the git hook script.

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { tryRunGit, tryRunGitLines } from '@/core/host/git/exec.ts';

import { runSecretsStage } from './git-pre-push-secrets.ts';
import { MissingDependenciesError, SECRETS_INACTIVE_UNAUTHENTICATED } from './hook-dependencies.ts';
import type { PushRef } from './stdin.ts';
import { readGitPushRefs } from './stdin.ts';

// Zero-OID width follows the repository hash algorithm: 40 under SHA-1, 64 under SHA-256.
const NULL_OID_PATTERN = /^0+$/;

export interface GitPrePushOptions {
  /** Remote git is pushing to, forwarded from the hook's first argument. */
  remoteName?: string;
}

export async function gitPrePush(
  options: GitPrePushOptions,
  files: string[],
  ctx: CommandInvocationContext,
): Promise<void> {
  const fileGroups = await getFileGroupsToScan(files, resolveRemotesExclusion(options.remoteName));
  if (fileGroups === null) return;

  const auth = await ctx.resolveAuthOrNull();
  if (!auth) {
    throw new MissingDependenciesError(SECRETS_INACTIVE_UNAUTHENTICATED);
  }

  for (const group of fileGroups) {
    await runSecretsStage(group, auth, ctx);
  }
}

/**
 * Scoping to the push target keeps an unrelated remote's tracking refs from hiding a commit that
 * remote has never seen. Hooks installed before the name was forwarded fall back to every remote.
 */
function resolveRemotesExclusion(remoteName: string | undefined): string {
  const name = remoteName?.trim();
  return name ? `--remotes=${name}` : '--remotes';
}

async function getFileGroupsToScan(
  files: string[],
  remotesExclusion: string,
): Promise<string[][] | null> {
  if (files.length > 0) {
    /*
     * pre-commit framework pre-chunks files before calling our tool in parallel.
     * This is suboptimal for SCA analysis, as it may be triggered multiple times for the same changes.
     * However, there's no easy solution, as the pre-commit framework can't pass all files at once due to ARG_MAX limits
     * and there's no support for stdin.
     */
    return [files];
  }

  const refs = await readGitPushRefs();
  if (refs.length === 0) return null;

  const nonDeletionRefs = refs.filter((ref) => !NULL_OID_PATTERN.test(ref.localSha));
  const filesByRef = await collectFilesForRefs(nonDeletionRefs, remotesExclusion);
  const groups = Array.from(filesByRef.values()).filter((g) => g.length > 0);
  return groups.length > 0 ? groups : null;
}

async function collectFilesForRefs(
  refs: PushRef[],
  remotesExclusion: string,
): Promise<Map<PushRef, string[]>> {
  const out = new Map<PushRef, string[]>();
  for (const ref of refs) {
    out.set(ref, await getFilesForRef(ref, remotesExclusion));
  }
  return out;
}

async function getFilesForRef(ref: PushRef, remotesExclusion: string): Promise<string[]> {
  const files = new Set<string>();
  for (const commit of await listCommitsToPush(ref, remotesExclusion)) {
    for (const file of await listFilesInCommit(commit)) {
      files.add(file);
    }
  }
  return Array.from(files);
}

/** Commits this push would transfer; empty means the remote already holds all of them. */
async function listCommitsToPush(ref: PushRef, remotesExclusion: string): Promise<string[]> {
  const knownRemoteTip = (await isKnownCommit(ref.remoteSha)) ? [ref.remoteSha] : [];
  const args = ['rev-list', ref.localSha, '--not', ...knownRemoteTip, remotesExclusion];
  return (await tryRunGitLines(args, process.cwd())) ?? [];
}

async function listFilesInCommit(commit: string): Promise<string[]> {
  const args = [
    'diff-tree',
    '--root',
    '--no-commit-id',
    '-r',
    '--name-only',
    '--diff-filter=ACMR',
    commit,
  ];
  return (await tryRunGitLines(args, process.cwd())) ?? [];
}

/** A remote tip this clone never fetched cannot narrow the range. */
async function isKnownCommit(oid: string): Promise<boolean> {
  if (NULL_OID_PATTERN.test(oid)) return false;
  return (await tryRunGit(['cat-file', '-e', `${oid}^{commit}`], process.cwd())) !== undefined;
}
