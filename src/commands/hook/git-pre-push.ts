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

// git pre-push callback handler — scans the content the push would transfer for secrets in a single analyzer
// call, one scan per commit, so a finding still names the commit that introduced it.

import type { SecretsJsonIssue } from '@/commands/analyze/secrets.ts';
import { MAX_SCANNED_FILE_SIZE } from '@/commands/analyze/secrets.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { tryRunGit, tryRunGitLines } from '@/core/host/git/exec.ts';
import { decodeGitPath } from '@/core/host/git/quoted-path.ts';
import { writeChunk } from '@/core/process/process.ts';

import type { GitBlobRef } from './git-blob-batch.ts';
import { isEncodablePath, readBlobContents, readBlobSizes, scanChunks } from './git-blob-batch.ts';
import type { BatchScanOutcome } from './git-pre-push-secrets.ts';
import { runSecretsStage, scanCommitScans } from './git-pre-push-secrets.ts';
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
  const pushed = await getPushedCommitBlobs(refs, remotesExclusion);
  const commits = await dropOversizeBlobs(pushed);
  if (commits.length === 0) return;

  await scanCommits(commits, await resolveAuth(ctx), ctx);
}

/**
 * Leaves out content the analyzer would skip for its size, so a large blob is never read into memory. A blob with no
 * reported size is kept, so the read refuses the push rather than passing over it.
 */
async function dropOversizeBlobs(commits: CommitBlobs[]): Promise<CommitBlobs[]> {
  const sizes = await readBlobSizes(
    commits.flatMap((commit) => commit.blobs),
    process.cwd(),
  );
  if (sizes === null) return commits;

  const withinLimit: CommitBlobs[] = [];
  for (const { commit, blobs } of commits) {
    const kept = blobs.filter((blob) => (sizes.get(blob.oid) ?? 0) <= MAX_SCANNED_FILE_SIZE);
    if (kept.length > 0) withinLimit.push({ commit, blobs: kept });
  }
  return withinLimit;
}

async function scanCommits(
  commits: CommitBlobs[],
  auth: ResolvedAuth,
  ctx: CommandInvocationContext,
): Promise<void> {
  // A holder rather than a local, so the assignment inside the writer is visible to the check after it.
  const unreadable: { commit?: string } = {};
  const outcome = await scanCommitScans(
    async (stdin) => {
      for (const { commit, blobs } of commits) {
        const contents = await readBlobContents(blobs, process.cwd());
        if (contents === null) {
          unreadable.commit = commit;
          return;
        }
        for (const chunk of scanChunks(commit, contents)) {
          await writeChunk(stdin, chunk);
        }
      }
    },
    auth,
    ctx,
  );

  if (unreadable.commit !== undefined) {
    // Reporting a clean push for content we never read would be worse than refusing the push.
    throw new CommandFailedError(
      `Could not read the content of commit ${shortSha(unreadable.commit)} from git, so it was not scanned.`,
      { remediationHint: 'Check that the repository is readable, then retry the push.' },
    );
  }
  if (!outcome?.secretsFound) return;
  reportFindings(commits, outcome, ctx);
}

/** Attributes each finding to the commit whose scan produced it, then refuses the push. */
function reportFindings(
  commits: CommitBlobs[],
  outcome: BatchScanOutcome,
  ctx: CommandInvocationContext,
): never {
  const byScan = groupByScanId(outcome.issues);
  const offending: string[] = [];
  for (const { commit } of commits) {
    const issues = byScan.get(commit);
    if (!issues) continue;
    byScan.delete(commit);
    ctx.console.print(`  commit ${commit}`);
    printSecretsFindingsOrStderr(issues, '', ctx.console);
    offending.push(commit);
  }

  // A finding no pushed commit claims still blocks, so print it rather than drop it.
  const unattributed = [...byScan.values()].flat();
  if (unattributed.length > 0 || offending.length === 0) {
    printSecretsFindingsOrStderr(unattributed, outcome.stderr, ctx.console);
  }

  const scope = offending.length > 0 ? offending.map(shortSha).join(', ') : 'pushed commits';
  throw new CommandFailedError(`Secrets detected in ${scope}.`, {
    remediationHint:
      'Remove the secret from the commit that introduced it, rewrite that commit, then retry the push.',
  });
}

/** The analyzer does not return findings in the order they were sent, so they are grouped rather than sliced. */
function groupByScanId(issues: SecretsJsonIssue[]): Map<string, SecretsJsonIssue[]> {
  const byScan = new Map<string, SecretsJsonIssue[]>();
  for (const issue of issues) {
    const group = byScan.get(issue.scanId ?? '');
    if (group) {
      group.push(issue);
    } else {
      byScan.set(issue.scanId ?? '', [issue]);
    }
  }
  return byScan;
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
 * pushed ref, so a commit two refs share is scanned once; `-c` catches content a merge introduced itself.
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
  return path ? { oid, path: batchSafePath(path) } : null;
}

/** Git escapes a line break, so its quoted form still fits the batch header when the decoded name does not. */
function batchSafePath(field: string): string {
  const decoded = decodeGitPath(field);
  return isEncodablePath(decoded) ? decoded : field;
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
