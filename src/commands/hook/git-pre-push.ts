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
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { MAX_SCANNED_FILE_SIZE } from '@/core/config-constants.ts';
import { tryRunGit, tryRunGitLines } from '@/core/host/git/exec.ts';
import { decodeGitPath } from '@/core/host/git/quoted-path.ts';
import { ProcessTimedOutError, spawnProcessWithTimeout } from '@/core/process/process.ts';

import type { GitBlobRef } from './git-blob-batch.ts';
import { isEncodablePath, readBlobContents, readBlobSizes, scanChunks } from './git-blob-batch.ts';
import type { BatchScanOutcome } from './git-pre-push-secrets.ts';
import { runSecretsStage, scanCommitScans } from './git-pre-push-secrets.ts';
import { tracePrePush, tracePrePushGitSpawnResult } from './git-pre-push-trace.ts';
import { MissingDependenciesError, SECRETS_INACTIVE_UNAUTHENTICATED } from './hook-dependencies.ts';
import { printSecretsFindingsOrStderr } from './secrets-display.ts';
import type { PushRef } from './stdin.ts';
import { readGitPushRefs } from './stdin.ts';

const GIT_LOG_TIMEOUT_MS = 60_000;

// Zero-OID width follows the repository hash algorithm: 40 under SHA-1, 64 under SHA-256.
const NULL_OID_PATTERN = /^0+$/;
const COMMIT_LINE_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** In a `git log --raw` change line, the destination object name sits immediately before the status field. */
const DESTINATION_OID_OFFSET = -2;

const GITLINK_MODE = '160000';

const SHORT_SHA_LENGTH = 8;

/** How much of an unexpected `git log --raw` line the trace prints. */
const RAW_LINE_TRACE_PREFIX_LENGTH = 120;

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
  tracePrePush(
    `gitPrePush: start cwd=${process.cwd()} filesMode=${files.length > 0} fileCount=${files.length} remoteNameOption=${options.remoteName ?? '(unset)'} ${REMOTE_NAME_ENV}=${process.env[REMOTE_NAME_ENV] ?? '(unset)'}`,
  );

  if (files.length > 0) {
    // Only filenames reach us here, with no commits to read them from, so this falls back to the working tree.
    tracePrePush(`gitPrePush: files mode, scanning ${files.length} path(s): ${files.join(', ')}`);
    await runSecretsStage(files, await resolveAuth(ctx), ctx);
    tracePrePush('gitPrePush: files mode finished (exit 0 unless throw)');
    return;
  }

  const refs = await readGitPushRefs();
  if (refs.length === 0) {
    tracePrePush('gitPrePush: early exit 0 — no push refs from stdin');
    return;
  }

  const remotesExclusion = await resolveRemotesExclusion(options.remoteName);
  tracePrePush(`gitPrePush: remotesExclusion=${remotesExclusion}`);
  const pushed = await getPushedCommitBlobs(refs, remotesExclusion);
  const commits = await dropOversizeBlobs(pushed);
  if (commits.length === 0) {
    tracePrePush(
      'gitPrePush: early exit 0 — no commits with scannable blobs after listing/filtering',
    );
    return;
  }

  tracePrePush(
    `gitPrePush: scanning ${commits.length} commit(s), ${commits.reduce((n, c) => n + c.blobs.length, 0)} blob(s) total`,
  );
  await scanCommits(commits, await resolveAuth(ctx), ctx);
  tracePrePush('gitPrePush: finished scan stage (exit 0 — no secrets reported)');
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
  if (sizes === null) {
    tracePrePush('dropOversizeBlobs: blob sizes unavailable (null), keeping all commits/blobs');
    return commits;
  }

  const withinLimit: CommitBlobs[] = [];
  for (const { commit, blobs } of commits) {
    const kept = blobs.filter((blob) => {
      const size = sizes.get(blob.oid) ?? 0;
      if (size <= MAX_SCANNED_FILE_SIZE) return true;
      tracePrePush(
        `dropOversizeBlobs: skip ${blob.path} oid=${blob.oid.slice(0, SHORT_SHA_LENGTH)} size=${size} > limit=${MAX_SCANNED_FILE_SIZE}`,
      );
      return false;
    });
    if (kept.length > 0) withinLimit.push({ commit, blobs: kept });
    else
      tracePrePush(
        `dropOversizeBlobs: commit ${commit.slice(0, SHORT_SHA_LENGTH)} has no blobs within size limit`,
      );
  }
  tracePrePush(
    `dropOversizeBlobs: ${commits.length} commit(s) in -> ${withinLimit.length} commit(s) with blobs out`,
  );
  return withinLimit;
}

async function scanCommits(
  commits: CommitBlobs[],
  auth: ResolvedAuth,
  ctx: CommandInvocationContext,
): Promise<void> {
  const outcome = await scanCommitScans(batchOf(commits), auth, ctx);

  if (outcome === null) {
    tracePrePush('scanCommits: scanCommitScans returned null (fail-soft) — allowing push');
    return;
  }
  tracePrePush(
    `scanCommits: secretsFound=${outcome.secretsFound} issueCount=${outcome.issues.length} analyzer stderr length=${outcome.stderr.length}`,
  );
  if (!outcome.secretsFound) return;
  reportFindings(commits, outcome, ctx);
}

/** Yields one commit at a time, so only the commit being written is held. */
async function* batchOf(commits: CommitBlobs[]): AsyncGenerator<Buffer> {
  for (const { commit, blobs } of commits) {
    const contents = await readBlobContents(blobs, process.cwd());
    if (contents === null) {
      // Reporting a clean push for content we never read would be worse than refusing the push.
      throw new CommandFailedError(
        `Could not read the content of commit ${shortSha(commit)} from git, so it was not scanned.`,
        { remediationHint: 'Check that the repository is readable, then retry the push.' },
      );
    }
    yield* scanChunks(commit, contents);
  }
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
  if (!name) {
    tracePrePush('resolveRemotesExclusion: no remote name, using --remotes');
    return '--remotes';
  }
  const configured = await tryRunGitLines(['remote'], process.cwd());
  if (configured === undefined) {
    tracePrePush('resolveRemotesExclusion: git remote failed');
    throw new CommandFailedError(
      'Secrets scan could not run because Git remotes could not be listed.',
      { remediationHint: "Run `git remote` to see Git's error, then retry the push." },
    );
  }
  tracePrePush(`resolveRemotesExclusion: git remote list=${configured.join(', ') || '(empty)'}`);
  const exclusion = configured.includes(name) ? `--remotes=${name}` : '--remotes';
  tracePrePush(
    `resolveRemotesExclusion: push remote name=${name} configured=${configured.includes(name)} -> ${exclusion}`,
  );
  return exclusion;
}

/**
 * Groups the blobs the push would transfer by the commit that introduced them, oldest first. One walk over every
 * pushed ref, so a commit two refs share is scanned once; `-c` catches content a merge introduced itself.
 */
function traceNullOidRefs(refs: PushRef[]): void {
  for (const ref of refs) {
    if (NULL_OID_PATTERN.test(ref.localSha)) {
      tracePrePush(
        `getPushedCommitBlobs: ref localSha is null OID (branch delete?) localRef=${ref.localRef}`,
      );
    }
    if (NULL_OID_PATTERN.test(ref.remoteSha)) {
      tracePrePush(
        `getPushedCommitBlobs: ref remoteSha is null OID (new branch?) remoteRef=${ref.remoteRef}`,
      );
    }
  }
}

function parsePushedCommitGroups(lines: string[]): CommitBlobs[] {
  const groups: CommitBlobs[] = [];
  let unparsedRawLines = 0;
  for (const line of lines) {
    if (COMMIT_LINE_PATTERN.test(line)) {
      groups.push({ commit: line, blobs: [] });
      continue;
    }
    const blob = parseRawBlobLine(line);
    if (!blob && line.startsWith(':')) unparsedRawLines += 1;
    const current = groups.at(-1);
    if (blob && current) {
      current.blobs.push(blob);
    } else if (blob && !current) {
      tracePrePush(
        `getPushedCommitBlobs: raw blob line before any commit header: ${line.slice(0, RAW_LINE_TRACE_PREFIX_LENGTH)}`,
      );
    }
  }
  if (unparsedRawLines > 0) {
    tracePrePush(`getPushedCommitBlobs: ${unparsedRawLines} raw line(s) not parsed as blobs`);
  }
  tracePrePush(
    `getPushedCommitBlobs: parsed ${groups.length} commit group(s) before reverse/dedupe`,
  );
  for (const group of groups) {
    tracePrePush(
      `getPushedCommitBlobs: pre-reverse commit ${group.commit.slice(0, SHORT_SHA_LENGTH)} blobCount=${group.blobs.length}`,
    );
  }
  return groups;
}

async function getPushedCommitBlobs(
  refs: PushRef[],
  remotesExclusion: string,
): Promise<CommitBlobs[]> {
  traceNullOidRefs(refs);

  const localShas = [
    ...new Set(refs.map((ref) => ref.localSha).filter((sha) => !NULL_OID_PATTERN.test(sha))),
  ];
  tracePrePush(
    `getPushedCommitBlobs: ${refs.length} ref(s) -> ${localShas.length} unique localSha(s) after null-OID filter: ${localShas.join(', ') || '(none)'}`,
  );
  if (localShas.length === 0) {
    tracePrePush('getPushedCommitBlobs: returning [] — no local SHAs to walk');
    return [];
  }

  const remoteTips = await knownRemoteTips(refs);
  tracePrePush(
    `getPushedCommitBlobs: knownRemoteTips for --not (${remoteTips.length}): ${remoteTips.join(', ') || '(none)'}`,
  );

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
    ...remoteTips,
    remotesExclusion,
  ];
  const errorMessage =
    'Secrets scan could not run because the files being pushed could not be listed by Git.';
  let result;
  try {
    result = await spawnProcessWithTimeout(
      'git',
      args,
      { cwd: process.cwd() },
      GIT_LOG_TIMEOUT_MS,
      'git log timed out',
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    tracePrePush(`getPushedCommitBlobs: spawn failed: ${detail}`);
    throw new CommandFailedError(`${errorMessage} ${detail}`, {
      remediationHint:
        error instanceof ProcessTimedOutError
          ? 'Check for a Git lock or a very large push range, then retry the push.'
          : 'Check that Git is installed, then retry the push.',
    });
  }
  tracePrePushGitSpawnResult('getPushedCommitBlobs git log', args, result);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new CommandFailedError(
      detail ? `${errorMessage} Git reported: ${detail}` : errorMessage,
      {
        remediationHint: 'Fix the Git error, then retry the push.',
      },
    );
  }
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  tracePrePush(`getPushedCommitBlobs: git log produced ${lines.length} stdout line(s)`);

  const groups = parsePushedCommitGroups(lines);
  // `git log` walks newest first; reversing attributes each blob to the commit that first carried it.
  groups.reverse();
  return dedupeAcrossCommits(groups);
}

function dedupeAcrossCommits(groups: CommitBlobs[]): CommitBlobs[] {
  const seen = new Set<string>();
  const result: CommitBlobs[] = [];
  for (const group of groups) {
    const blobs: GitBlobRef[] = [];
    for (const blob of group.blobs) {
      const key = `${blob.oid}\t${blob.path}`;
      if (seen.has(key)) {
        tracePrePush(
          `dedupeAcrossCommits: skip duplicate ${blob.path} oid=${blob.oid.slice(0, SHORT_SHA_LENGTH)} commit=${group.commit.slice(0, SHORT_SHA_LENGTH)}`,
        );
        continue;
      }
      if (!isEncodablePath(blob.path)) {
        tracePrePush(
          `dedupeAcrossCommits: skip non-encodable path ${blob.path} commit=${group.commit.slice(0, SHORT_SHA_LENGTH)}`,
        );
        continue;
      }
      seen.add(key);
      blobs.push(blob);
    }
    if (blobs.length > 0) result.push({ commit: group.commit, blobs });
    else
      tracePrePush(
        `dedupeAcrossCommits: commit ${group.commit.slice(0, SHORT_SHA_LENGTH)} omitted (no blobs after dedupe)`,
      );
  }
  tracePrePush(
    `dedupeAcrossCommits: ${groups.length} group(s) -> ${result.length} commit(s) with scannable blobs`,
  );
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
  const shas = [...new Set(refs.map((ref) => ref.remoteSha))];
  const known = await Promise.all(
    shas.map(async (sha) => {
      const isKnown = await isKnownCommit(sha);
      if (NULL_OID_PATTERN.test(sha)) {
        tracePrePush(`knownRemoteTips: remoteSha ${sha} is null OID -> excluded from --not`);
      } else {
        tracePrePush(`knownRemoteTips: remoteSha ${sha} known=${isKnown}`);
      }
      return isKnown;
    }),
  );
  return shas.filter((_, index) => known[index]);
}

/** A remote tip this clone never fetched cannot narrow the range. */
async function isKnownCommit(oid: string): Promise<boolean> {
  if (NULL_OID_PATTERN.test(oid)) return false;
  return (await tryRunGit(['cat-file', '-e', `${oid}^{commit}`], process.cwd())) !== undefined;
}

function shortSha(commit: string): string {
  return commit.slice(0, SHORT_SHA_LENGTH);
}
