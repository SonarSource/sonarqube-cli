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

// Final step — ingest SonarQube config files into each selected repository

import { blank, text } from '../../../../ui';
import { bold, cyan, dim, green, red, yellow } from '../../../../ui/colors.js';
import type { OrgOnboardingResult, RepoInstallResult, RepoInstallStatus } from '../types.js';
import { stepHeader } from './ui.js';

// Files to ingest into each repo (mocked — real implementation TBD)
const SONARQUBE_FILES = ['sonar-project.properties', '.github/workflows/sonarqube.yml'];

const CTRL_C = 0x03;
const EXIT_CODE_SIGINT = 130;

// ─── Progress bar ────────────────────────────────────────────────────────────

function renderBar(done: number, total: number, width = 32): string {
  const pct = total === 0 ? 1 : Math.min(done / total, 1);
  const filled = Math.round(pct * width);
  const bar = '█'.repeat(filled) + dim('░'.repeat(width - filled));
  const pctLabel = `${Math.round(pct * 100)}%`;
  return `${bar}  ${pctLabel}  ${dim(String(done) + '/' + String(total))}`;
}

function writeBar(done: number, total: number, paused: boolean): void {
  const status = paused ? yellow('  ⏸  paused') : '';
  const line = `  ${renderBar(done, total)}${status}`;
  // Overwrite the current line in place
  process.stdout.write('\r\x1b[K' + line);
}

function clearBar(): void {
  process.stdout.write('\r\x1b[K');
}

// ─── Log lines (printed above the progress bar) ───────────────────────────────

const STATUS_ICON: Record<RepoInstallStatus, string> = {
  pending: dim('○'),
  running: cyan('⠿'),
  done: green('✓'),
  failed: red('✗'),
  skipped: dim('⏭'),
};

function logRepo(result: RepoInstallResult): void {
  const icon = STATUS_ICON[result.status];
  const repoName = result.repo.split('/')[1] ?? result.repo;
  const orgLabel = dim(result.org + '/');
  const errorSuffix = result.error ? `  ${red(result.error)}` : '';
  // Move up past the bar line, print the log, then reprint the bar
  process.stdout.write('\r\x1b[K'); // clear bar
  process.stdout.write(`  ${icon}  ${orgLabel}${repoName}${errorSuffix}\n`);
}

// ─── Keyboard control (pause / resume / stop) ─────────────────────────────────

type ControlSignal = 'pause' | 'resume' | 'stop' | 'none';

function readControlKey(chunk: Buffer): ControlSignal {
  if (chunk[0] === CTRL_C) return 'stop';
  const ch = chunk.toString('utf8').toLowerCase();
  if (ch === 'p') return 'pause';
  if (ch === 'r') return 'resume';
  if (ch === 's') return 'stop';
  return 'none';
}

// ─── Mock install ─────────────────────────────────────────────────────────────

async function mockInstallRepo(repo: string): Promise<void> {
  // Simulate variable-duration work and occasional failures
  const delay = 300 + Math.floor((repo.length * 137) % 700);
  await new Promise<void>((resolve) => setTimeout(resolve, delay));

  // ~10% failure rate for demo purposes
  if ((repo.codePointAt(repo.length - 1) ?? 0) % 10 === 0) {
    throw new Error('Simulated install failure');
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

// ─── Install loop ─────────────────────────────────────────────────────────────

async function runInstallLoop(
  allRepos: { org: string; repo: string }[],
): Promise<{ results: RepoInstallResult[]; stopped: boolean }> {
  const results: RepoInstallResult[] = [];
  const total = allRepos.length;
  let done = 0;
  let paused = false;
  let stopped = false;

  const { teardown } = setupStdin((chunk) => {
    const signal = readControlKey(chunk);
    if (signal === 'pause' && !paused) {
      paused = true;
      writeBar(done, total, true);
    } else if (signal === 'resume' && paused) {
      paused = false;
      writeBar(done, total, false);
    } else if (signal === 'stop') {
      stopped = true;
    } else if (chunk[0] === CTRL_C) {
      stopped = true;
      teardown();
      process.exit(EXIT_CODE_SIGINT);
    }
  });

  writeBar(0, total, false);

  for (const { org, repo } of allRepos) {
    // `paused`/`stopped` are mutated asynchronously by the stdin key handler above,
    // which ESLint's flow analysis cannot see — hence the false "always falsy" reports.
    /* eslint-disable @typescript-eslint/no-unnecessary-condition */
    if (stopped) break;

    while (paused && !stopped) {
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    if (stopped) break;
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */

    let status: RepoInstallStatus = 'done';
    let error: string | undefined;
    try {
      await mockInstallRepo(repo);
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
    }

    const result: RepoInstallResult = { repo, org, status, error };
    results.push(result);
    done++;
    logRepo(result);
    writeBar(done, total, paused);
  }

  teardown();
  return { results, stopped };
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function printSummary(results: RepoInstallResult[], total: number, stopped: boolean): void {
  const failed = results.filter((r) => r.status === 'failed');
  const skipped = total - results.length;
  const succeeded = results.filter((r) => r.status === 'done').length;

  if (stopped && skipped > 0) {
    text(`  ${yellow('⏹')}  Stopped — ${dim(String(skipped) + ' repositories skipped')}`);
    blank();
  }

  if (failed.length > 0) {
    const noun = failed.length === 1 ? 'repository' : 'repositories';
    text(`  ${red('✗')}  ${String(failed.length)} ${noun} failed to install`);
    blank();
    for (const f of failed) {
      const repoName = f.repo.split('/')[1] ?? f.repo;
      text(`      ${dim(f.org + '/')}${repoName}  ${red(f.error ?? 'unknown error')}`);
    }
    blank();
  }

  const noun = succeeded === 1 ? 'repository' : 'repositories';
  text(`  ${green('✓')}  ${String(succeeded)} ${noun} installed successfully`);
  blank();
}

// ─── Main step ────────────────────────────────────────────────────────────────

export async function runStepInstall(
  orgResults: OrgOnboardingResult[],
  stepNumber: number,
  totalSteps: number,
): Promise<RepoInstallResult[]> {
  const allRepos = orgResults.flatMap((r) =>
    r.selectedRepositories.map((repo) => ({ org: r.org, repo: repo.fullName })),
  );

  stepHeader(stepNumber, totalSteps, 'Installing SonarQube');
  blank();
  text(bold('Files to ingest per repository:'));
  for (const f of SONARQUBE_FILES) {
    text(`  ${dim('·')}  ${f}`);
  }
  blank();
  text(dim('p  Pause    r  Resume    s  Stop    Ctrl+C  Abort'));
  blank();

  if (allRepos.length === 0) {
    text(dim('No repositories selected for installation.'));
    blank();
    return [];
  }

  const { results, stopped } = await runInstallLoop(allRepos);

  clearBar();
  blank();
  printSummary(results, allRepos.length, stopped);

  return results;
}
