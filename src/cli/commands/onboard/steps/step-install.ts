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

// Final step — start a server-side onboarding job per organization and watch its
// progress, rendering a live per-repository status table until every repository
// reaches a terminal stage.

import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import type {
  OnboardingJob,
  OnboardingRepoProgress,
  OnboardingStage,
} from '../../../../sonarqube/client';
import { SonarQubeClient } from '../../../../sonarqube/client';
import { blank, text, withSpinner } from '../../../../ui';
import { bold, cyan, dim, green, red, yellow } from '../../../../ui/colors.js';
import type { InstallOptions, OrgOnboardingResult, RepoInstallResult } from '../types.js';
import type { StepperState } from './stepper.js';
import { renderStepper } from './stepper.js';

// Default branch sent to the onboarding endpoint for every repository. The server
// resolves per-repo branches today, so a single value is sufficient.
const DEFAULT_BRANCH = 'main';

// How long to wait between progress polls.
const POLL_INTERVAL_MS = 2000;

// Spinner animation frames + cadence for in-flight repositories. The table is
// repainted on this faster timer so active rows animate between the slower polls.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_INTERVAL_MS = 80;

// Upper bound on how long we keep watching before giving up locally. The server
// jobs keep running regardless; this only stops the local watch loop.
const MAX_WATCH_MS = 30 * 60 * 1000; // 30 minutes

const CTRL_C = 0x03;
const EXIT_CODE_SIGINT = 130;

// Order in which stages flow, used to render the stage-counts summary line.
const STAGE_ORDER: OnboardingStage[] = [
  'IMPORTING',
  'CONFIGURING',
  'ANALYZING',
  'AWAITING_MERGE',
  'COMPLETED',
  'FAILED',
];

// ─── Stage / status presentation ───────────────────────────────────────────────

// Human-readable label for an in-flight or terminal stage.
const STAGE_LABEL: Record<OnboardingStage, string> = {
  IMPORTING: 'Importing',
  CONFIGURING: 'Configuring',
  ANALYZING: 'Analyzing',
  AWAITING_MERGE: 'PR open — awaiting merge',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
};

/**
 * Short, human-readable reason for a failed repository. The `errorMessage` field
 * is usually null; the actionable signal is `engineStatus`. We deliberately do not
 * surface the long LLM `notes` prose here.
 */
function failureReason(repo: OnboardingRepoProgress | undefined): string {
  if (!repo) return 'Onboarding failed';
  if (repo.errorMessage) {
    // Server-side watcher errors (e.g. component-not-found 404s) come through here.
    return repo.errorMessage.replace(/\s+/g, ' ').trim();
  }
  const reasons: Record<string, string> = {
    CI_FAILED_MAX_RETRIES: 'CI failed (max retries reached)',
    CI_FAILED_UNABLE_TO_FIX: 'CI failed (could not auto-fix)',
    CI_FAILED_UNRELATED: 'CI failed (unrelated to SonarQube)',
    ERROR: 'Onboarding error',
  };
  if (!repo.engineStatus) return 'Onboarding failed';
  return reasons[repo.engineStatus] ?? `Failed (${repo.engineStatus})`;
}

/**
 * Whether a stage is terminal for this run. `AWAITING_MERGE` is terminal when we
 * opened a pull request (the repo is done from the CLI's perspective — a human
 * merges the PR), but still in-flight when committing to the main branch.
 */
function isTerminalStage(stage: OnboardingStage, prMode: boolean): boolean {
  if (stage === 'COMPLETED' || stage === 'FAILED') return true;
  return stage === 'AWAITING_MERGE' && prMode;
}

function isSuccessStage(stage: OnboardingStage): boolean {
  return stage === 'COMPLETED' || stage === 'AWAITING_MERGE';
}

// ─── Live status table ─────────────────────────────────────────────────────────

interface TrackedRepo {
  org: string;
  repo: string; // bare repo name (after the org/ prefix)
  fullName: string; // org/repo as returned by the server
  stage: OnboardingStage | null; // null until first observed
  progress?: OnboardingRepoProgress;
}

function shortName(fullName: string): string {
  return fullName.split('/')[1] ?? fullName;
}

function stageIcon(stage: OnboardingStage | null, prMode: boolean, frame: number): string {
  if (stage === null) return dim('○');
  if (stage === 'FAILED') return red('✗');
  if (isTerminalStage(stage, prMode)) return green('✓');
  return cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]);
}

function repoLine(t: TrackedRepo, prMode: boolean, frame: number): string {
  const icon = stageIcon(t.stage, prMode, frame);
  const name = shortName(t.fullName);
  const orgLabel = dim(t.org + '/');

  if (t.stage === null) {
    return `  ${icon}  ${orgLabel}${name}  ${dim('queued')}`;
  }

  if (t.stage === 'FAILED') {
    return `  ${icon}  ${orgLabel}${name}  ${red(failureReason(t.progress))}`;
  }

  const label = STAGE_LABEL[t.stage];
  const key = t.progress?.sonarProjectKey ? dim(`  ${t.progress.sonarProjectKey}`) : '';

  if (isTerminalStage(t.stage, prMode) && isSuccessStage(t.stage)) {
    const pr = t.progress?.prUrl ? dim(`  ${t.progress.prUrl}`) : '';
    return `  ${icon}  ${orgLabel}${name}  ${green(label)}${key}${pr}`;
  }

  const attempt =
    t.progress?.agentAttempt && t.progress.agentAttempt > 1
      ? dim(`  attempt ${String(t.progress.agentAttempt)}`)
      : '';
  return `  ${icon}  ${orgLabel}${name}  ${cyan(label)}${key}${attempt}`;
}

function renderBar(done: number, total: number, width = 32): string {
  const pct = total === 0 ? 1 : Math.min(done / total, 1);
  const filled = Math.round(pct * width);
  const bar = '█'.repeat(filled) + dim('░'.repeat(width - filled));
  const pctLabel = `${Math.round(pct * 100)}%`;
  return `  ${bar}  ${pctLabel}  ${dim(String(done) + '/' + String(total))}`;
}

function stageCountsLine(tracked: TrackedRepo[]): string {
  const counts = new Map<OnboardingStage, number>();
  for (const t of tracked) {
    if (t.stage) counts.set(t.stage, (counts.get(t.stage) ?? 0) + 1);
  }
  const parts = STAGE_ORDER.filter((s) => counts.has(s)).map(
    (s) => `${STAGE_LABEL[s]}: ${String(counts.get(s))}`,
  );
  return `  ${dim(parts.join('   ·   '))}`;
}

/**
 * Manages an in-place multi-line region: the per-repo table, a stage-counts line,
 * and a progress bar. Each repaint moves the cursor back up over the previously
 * drawn block and rewrites it.
 */
class LiveTable {
  private linesDrawn = 0;

  constructor(
    private readonly tracked: TrackedRepo[],
    private readonly prMode: boolean,
  ) {}

  render(done: number, total: number, frame: number): void {
    if (this.linesDrawn > 0) {
      process.stdout.write(`\x1b[${String(this.linesDrawn)}A`);
    }
    const lines = [
      ...this.tracked.map((t) => repoLine(t, this.prMode, frame)),
      '',
      stageCountsLine(this.tracked),
      renderBar(done, total),
    ];
    const out = lines.map((l) => `\r\x1b[K${l}`).join('\n') + '\n';
    process.stdout.write(out);
    this.linesDrawn = lines.length;
  }

  clear(): void {
    if (this.linesDrawn === 0) return;
    process.stdout.write(`\x1b[${String(this.linesDrawn)}A`);
    for (let i = 0; i < this.linesDrawn; i++) {
      process.stdout.write('\r\x1b[K');
      if (i < this.linesDrawn - 1) process.stdout.write('\n');
    }
    process.stdout.write(`\r\x1b[${String(this.linesDrawn - 1)}A`);
    this.linesDrawn = 0;
  }
}

// ─── Stdin control setup/teardown ─────────────────────────────────────────────

function setupStdin(onKey: (chunk: Buffer) => void): { teardown: () => void } {
  const stdinWasRaw = process.stdin.isTTY && (process.stdin as NodeJS.ReadStream).isRaw;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onKey);
  }
  return {
    teardown() {
      if (!process.stdin.isTTY) return;
      process.stdin.off('data', onKey);
      if (!stdinWasRaw) process.stdin.setRawMode(false);
      process.stdin.pause();
    },
  };
}

// ─── Start jobs ─────────────────────────────────────────────────────────────

interface StartedJobs {
  jobIds: Set<string>;
  // Repos that failed to even start.
  startFailures: RepoInstallResult[];
  // Repos we successfully started a job for.
  tracked: TrackedRepo[];
}

/**
 * Start one onboarding job per org with selected repositories. Records the job ids
 * so the progress poll can filter to our runs, and captures per-org start failures
 * so they surface in the summary instead of silently disappearing.
 */
async function startJobs(
  client: SonarQubeClient,
  orgResults: OrgOnboardingResult[],
): Promise<StartedJobs> {
  const jobIds = new Set<string>();
  const startFailures: RepoInstallResult[] = [];
  const tracked: TrackedRepo[] = [];

  for (const org of orgResults) {
    const fullNames = org.selectedRepositories.map((r) => r.fullName);
    if (fullNames.length === 0) continue;

    try {
      const job = await client.startOnboarding({
        organization: org.org,
        repositories: fullNames,
        defaultBranch: DEFAULT_BRANCH,
      });
      jobIds.add(job.jobId);
      for (const fullName of fullNames) {
        tracked.push({ org: org.org, repo: shortName(fullName), fullName, stage: null });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const fullName of fullNames) {
        startFailures.push({ repo: fullName, org: org.org, status: 'failed', error: message });
      }
    }
  }

  return { jobIds, startFailures, tracked };
}

// ─── Watch progress ─────────────────────────────────────────────────────────

interface WatchOutcome {
  results: RepoInstallResult[];
  stopped: boolean;
}

/**
 * Apply one poll's jobs onto the tracked repos, returning how many are terminal.
 * Matches server repos to tracked repos by `org/repo` fullName.
 */
function applyProgress(
  tracked: TrackedRepo[],
  jobs: OnboardingJob[],
  prMode: boolean,
): { done: number } {
  const byFullName = new Map<string, OnboardingRepoProgress>();
  for (const job of jobs) {
    for (const repo of job.repositories) {
      // Last write wins; jobs are returned newest-first but repos within our run
      // are unique per fullName.
      byFullName.set(repo.repo, repo);
    }
  }

  let done = 0;
  for (const t of tracked) {
    const progress = byFullName.get(t.fullName);
    if (progress) {
      t.stage = progress.stage;
      t.progress = progress;
    }
    if (t.stage && isTerminalStage(t.stage, prMode)) done++;
  }
  return { done };
}

function trackedToResult(t: TrackedRepo, prMode: boolean): RepoInstallResult {
  if (t.stage && isTerminalStage(t.stage, prMode) && isSuccessStage(t.stage)) {
    return { repo: t.fullName, org: t.org, status: 'done' };
  }
  if (t.stage === 'FAILED') {
    return { repo: t.fullName, org: t.org, status: 'failed', error: failureReason(t.progress) };
  }
  // Not terminal (still running when the watch ended).
  return { repo: t.fullName, org: t.org, status: 'running' };
}

/**
 * Poll the onboarding progress endpoint, repainting the live table each tick, until
 * every tracked repository reaches a terminal stage, the watch times out, or the
 * user stops watching.
 */
async function watchProgress(
  client: SonarQubeClient,
  jobIds: Set<string>,
  tracked: TrackedRepo[],
  prMode: boolean,
): Promise<WatchOutcome> {
  const total = tracked.length;
  const startedAt = Date.now();
  let stopped = false;

  const { teardown } = setupStdin((chunk) => {
    if (chunk[0] === CTRL_C) {
      teardown();
      process.exit(EXIT_CODE_SIGINT);
    }
    if (chunk.toString('utf8').toLowerCase() === 's') stopped = true;
  });

  const table = new LiveTable(tracked, prMode);
  let done = 0;
  let frame = 0;

  // Repaint on a fast timer so in-flight rows animate between the slower polls.
  const animate = setInterval(() => {
    table.render(done, total, frame);
    frame++;
  }, FRAME_INTERVAL_MS);

  // `stopped` is mutated asynchronously by the stdin handler above, which ESLint's
  // flow analysis cannot see — hence the disable for the always-falsy reports.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  while (!stopped && done < total && Date.now() - startedAt < MAX_WATCH_MS) {
    await sleep(POLL_INTERVAL_MS);

    let jobs: OnboardingJob[];
    try {
      const progress = await client.getOnboardingProgress();
      jobs = progress.jobs.filter((j) => jobIds.has(j.jobId));
    } catch {
      // Transient failure — keep watching rather than aborting the whole run.
      continue;
    }

    done = applyProgress(tracked, jobs, prMode).done;
  }
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */

  clearInterval(animate);
  teardown();
  // Final paint so the last poll's terminal states are reflected, then clear.
  table.render(done, total, frame);
  table.clear();

  return { results: tracked.map((t) => trackedToResult(t, prMode)), stopped };
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function printSummary(results: RepoInstallResult[], stopped: boolean): void {
  const failed = results.filter((r) => r.status === 'failed');
  const running = results.filter((r) => r.status === 'running');
  const succeeded = results.filter((r) => r.status === 'done').length;

  if (stopped && running.length > 0) {
    text(
      `  ${yellow('⏹')}  Stopped watching — ${dim(String(running.length) + ' repositories still onboarding on the server')}`,
    );
    blank();
  } else if (running.length > 0) {
    text(
      `  ${yellow('⏱')}  ${dim(String(running.length) + ' repositories still onboarding on the server')}`,
    );
    blank();
  }

  if (failed.length > 0) {
    const noun = failed.length === 1 ? 'repository' : 'repositories';
    text(`  ${red('✗')}  ${String(failed.length)} ${noun} failed to onboard`);
    blank();
    for (const f of failed) {
      text(`      ${dim(f.org + '/')}${shortName(f.repo)}  ${red(f.error ?? 'unknown error')}`);
    }
    blank();
  }

  const noun = succeeded === 1 ? 'repository' : 'repositories';
  text(`  ${green('✓')}  ${String(succeeded)} ${noun} onboarded successfully`);
  blank();
}

// ─── Main step ────────────────────────────────────────────────────────────────

export async function runStepInstall(
  orgResults: OrgOnboardingResult[],
  options: InstallOptions,
  auth: ResolvedAuth,
  stepper: StepperState,
  stepIndex: number,
): Promise<RepoInstallResult[]> {
  renderStepper(stepper, stepIndex);
  blank();
  text(bold('Options:'));
  text(
    `  ${dim('·')}  ${options.injectIntoMainBranch ? 'Committing to the main branch' : 'Opening a pull request'}`,
  );
  text(
    `  ${dim('·')}  IDE (SonarLint) configuration: ${options.configureForIde ? green('enabled') : dim('disabled')}`,
  );
  blank();
  text(dim('s  Stop watching    Ctrl+C  Abort'));
  blank();

  const hasRepos = orgResults.some((r) => r.selectedRepositories.length > 0);
  if (!hasRepos) {
    text(dim('No repositories selected for onboarding.'));
    blank();
    return [];
  }

  const client = new SonarQubeClient(auth.serverUrl, auth.token);

  const { jobIds, startFailures, tracked } = await withSpinner('Starting onboarding…', () =>
    startJobs(client, orgResults),
  );

  const prMode = !options.injectIntoMainBranch;
  const { results, stopped } =
    tracked.length > 0
      ? await watchProgress(client, jobIds, tracked, prMode)
      : { results: [], stopped: false };

  blank();
  const allResults = [...startFailures, ...results];
  printSummary(allResults, stopped);

  return allResults;
}
