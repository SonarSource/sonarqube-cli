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

// git pre-push callback handler — scans the content the push would transfer for secrets,
// one analyzer call per commit so a finding names the commit that introduced it.

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { tryRunGit, tryRunGitLines } from '@/core/host/git/exec.ts';
import { decodeGitPath } from '@/core/host/git/quoted-path.ts';

import type { GitBlobRef } from './git-blob-batch.ts';
import { encodeBatch, isEncodablePath, readBlobContents } from './git-blob-batch.ts';
import { runSecretsStage, scanBatch } from './git-pre-push-secrets.ts';
import { MissingDependenciesError, SECRETS_INACTIVE_UNAUTHENTICATED } from './hook-dependencies.ts';
import { printSecretsFindingsOrStderr } from './secrets-display.ts';
import type { PushRef } from './stdin.ts';
import { readGitPushRefs } from './stdin.ts';

// Zero-OID width follows the repository hash algorithm: 40 under SHA-1, 64 under SHA-256.
const NULL_OID_PATTERN = /^0+$/;
const COMMIT_LINE_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** In a `git log --raw` change line, the destination object name sits immediately before the status field. */
const DESTINATION_OID_OFFSET = -2;

const GITLINK_MODE = '160000';

const SHORT_SHA_LENGTH = 8;

/** Set by the generated hook. An env var, not a flag, so an older CLI ignores it instead of failing. */
export const REMOTE_NAME_ENV = 'SONAR_PRE_PUSH_REMOTE_NAME';

export interface GitPrePushOptions {
  /** Remote git is pushing to; overrides `SONAR_PRE_PUSH_REMOTE_NAME`. */
  remoteName?: string;
}

/** The blobs a commit contributes to the push, attributed to the commit that first carries them. */
interface CommitBlobs {
  commit: string;
  blobs: GitBlobRef[];
}

export async function gitPrePush(
  options: GitPrePushOptions,
  files: string[],
  ctx: CommandInvocationContext,
): Promise<void> {
  /*
   * pre-commit framework pre-chunks files before calling our tool in parallel.
   * This is suboptimal for SCA analysis, as it may be triggered multiple times for the same changes.
   * However, there's no easy solution, as the pre-commit framework can't pass all files at once due to ARG_MAX limits
   * and there's no support for stdin.
   */
  if (files.length > 0) {
    // Only filenames reach us here, with no commits to read them from, so this falls back to the working tree.
    await runSecretsStage(files, await resolveAuth(ctx), ctx);
    return;
  }

  const refs = await readGitPushRefs();
  if (refs.length === 0) return;

  const remotesExclusion = await resolveRemotesExclusion(options.remoteName);
  const commits = await getPushedCommitBlobs(refs, remotesExclusion);
  if (commits.length === 0) return;

  await scanCommits(commits, await resolveAuth(ctx), ctx);
}

async function scanCommits(
  commits: CommitBlobs[],
  auth: ResolvedAuth,
  ctx: CommandInvocationContext,
): Promise<void> {
  const offending: string[] = [];
  for (const { commit, blobs } of commits) {
    const contents = await readBlobContents(blobs, process.cwd());
    if (contents === null) {
      // Reporting a clean push for content we never read would be worse than refusing the push.
      throw new CommandFailedError(
        `Could not read the content of commit ${shortSha(commit)} from git, so it was not scanned.`,
        { remediationHint: 'Check that the repository is readable, then retry the push.' },
      );
    }
    const outcome = await scanBatch(encodeBatch(contents), auth, ctx);
    // The failure is already warned and the push already allowed; retrying it per commit only repeats the wait.
    if (outcome === null) break;
    if (!outcome.secretsFound) continue;
    ctx.console.print(`  commit ${commit}`);
    printSecretsFindingsOrStderr(outcome.issues, outcome.stderr, ctx.console);
    offending.push(commit);
  }

  if (offending.length > 0) {
    throw new CommandFailedError(`Secrets detected in ${offending.map(shortSha).join(', ')}.`, {
      remediationHint:
        'Remove the secret from the commit that introduced it, rewrite that commit, then retry the push.',
    });
  }
}

async function resolveAuth(ctx: CommandInvocationContext): Promise<ResolvedAuth> {
  const auth = await ctx.resolveAuthOrNull();
  if (!auth) {
    throw new MissingDependenciesError(SECRETS_INACTIVE_UNAUTHENTICATED);
  }
  return auth;
}

/** Git passes a URL when the push names no remote, and `--remotes=<url>` matches no refs. */
async function resolveRemotesExclusion(remoteName: string | undefined): Promise<string> {
  const name = (remoteName ?? process.env[REMOTE_NAME_ENV])?.trim();
  if (!name) return '--remotes';
  const configured = (await tryRunGitLines(['remote'], process.cwd())) ?? [];
  return configured.includes(name) ? `--remotes=${name}` : '--remotes';
}

/**
 * Groups the blobs the push would transfer by the commit that introduced them, oldest first. One walk over every
 * pushed ref, so a commit two refs share is scanned once. `-c` also catches content a merge introduced itself.
 */
async function getPushedCommitBlobs(
  refs: PushRef[],
  remotesExclusion: string,
): Promise<CommitBlobs[]> {
  const localShas = [
    ...new Set(refs.map((ref) => ref.localSha).filter((sha) => !NULL_OID_PATTERN.test(sha))),
  ];
  if (localShas.length === 0) return [];

  const args = [
    'log',
    '--format=%H',
    '--raw',
    '--no-abbrev',
    '--diff-filter=ACMR',
    '-c',
    '--root',
    ...localShas,
    '--not',
    ...(await knownRemoteTips(refs)),
    remotesExclusion,
  ];
  const lines = (await tryRunGitLines(args, process.cwd())) ?? [];

  const groups: CommitBlobs[] = [];
  for (const line of lines) {
    if (COMMIT_LINE_PATTERN.test(line)) {
      groups.push({ commit: line, blobs: [] });
      continue;
    }
    const blob = parseRawBlobLine(line);
    const current = groups.at(-1);
    if (blob && current) {
      current.blobs.push(blob);
    }
  }
  // `git log` walks newest first; reversing attributes each blob to the commit that first carried it.
  groups.reverse();
  return dedupeAcrossCommits(groups);
}

function dedupeAcrossCommits(groups: CommitBlobs[]): CommitBlobs[] {
  const seen = new Set<string>();
  const result: CommitBlobs[] = [];
  for (const group of groups) {
    const blobs = group.blobs.filter((blob) => {
      const key = `${blob.oid}\t${blob.path}`;
      if (seen.has(key) || !isEncodablePath(blob.path)) return false;
      seen.add(key);
      return true;
    });
    if (blobs.length > 0) result.push({ commit: group.commit, blobs });
  }
  return result;
}

/**
 * Parses one `git log --raw` change line: a source mode per parent then the destination mode, the matching object
 * names, a status, then tab-separated paths — the last of which is a rename's new name. Merges lead with `::`.
 */
function parseRawBlobLine(line: string): GitBlobRef | null {
  if (!line.startsWith(':')) return null;
  const fields = line.split('\t');
  if (fields.length < 2) return null;
  const parentCount = /^:+/.exec(line)?.[0].length ?? 1;
  const meta = fields[0].slice(parentCount).split(' ');
  // A gitlink names a commit in the submodule's repository, not a blob here.
  if (meta[parentCount] === GITLINK_MODE) return null;
  const oid = meta.at(DESTINATION_OID_OFFSET);
  if (!oid || NULL_OID_PATTERN.test(oid)) return null;
  const path = fields.at(-1);
  return path ? { oid, path: decodeGitPath(path) } : null;
}

async function knownRemoteTips(refs: PushRef[]): Promise<string[]> {
  const tips: string[] = [];
  for (const sha of new Set(refs.map((ref) => ref.remoteSha))) {
    if (await isKnownCommit(sha)) tips.push(sha);
  }
  return tips;
}

/** A remote tip this clone never fetched cannot narrow the range. */
async function isKnownCommit(oid: string): Promise<boolean> {
  if (NULL_OID_PATTERN.test(oid)) return false;
  return (await tryRunGit(['cat-file', '-e', `${oid}^{commit}`], process.cwd())) !== undefined;
}

function shortSha(commit: string): string {
  return commit.slice(0, SHORT_SHA_LENGTH);
}
