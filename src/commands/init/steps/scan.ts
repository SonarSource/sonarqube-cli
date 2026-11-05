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

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliError, CommandFailedError } from '@/core/commands/command-error.ts';
import { DEFAULT_ANALYSIS_TIMEOUT_SECONDS } from '@/core/commands/poll.ts';
import {
  CLI_TMP_DIR,
  OWNER_ONLY_DIRECTORY_MODE,
  SHARED_PROJECT_CONFIG_FILE_NAME,
} from '@/core/config-constants.ts';
import { installSonarScanner } from '@/core/host/install/sonar-scanner.ts';
import logger from '@/core/observability/logger.ts';
import { ComputeEngineClient } from '@/core/server/compute-engine.ts';
import { IssuesClient } from '@/core/server/issues.ts';
import { QualityGatesClient } from '@/core/server/quality-gates.ts';
import type { QualityGateStatus } from '@/core/server/types.ts';
import type { Console } from '@/core/ui/console.ts';

import { DEFAULT_STATUSES } from '../../list/issues.ts';
import { requireAnswer } from '../answer.ts';
import { runScanner, startScannerInBackground } from '../scan/run-scanner.ts';
import { assertScannerNetworkUsable, scannerNetworkEnv } from '../scan/scanner-network.ts';
import type { DetectDeps } from './detect.ts';

/** What the user asked of the scan; validated before the login. */
export interface ScanFlags {
  scannerProperties: Map<string, string>;
  verbose: boolean;
  detach: boolean;
}

/**
 * The analysis is its own state, apart from the project setup that precedes it: `started` means
 * the scanner was handed off and nothing is known about its result, and a missing quality gate or
 * issue count is `null`, never zero.
 */
export type ScanResult =
  | { status: 'not-run' }
  | { status: 'started'; pid: number; logPath: string }
  | {
      status: 'completed';
      taskId: string;
      analysisId: string;
      logPath: string;
      qualityGate: QualityGateStatus | null;
      openIssues: number | null;
    };

/** Without a terminal there is nobody to ask, so only a scan flag counts as the request. */
function scanRequested(flags: ScanFlags): boolean {
  return flags.detach || flags.verbose || flags.scannerProperties.size > 0;
}

export const NOT_RUN: ScanResult = { status: 'not-run' };

const DETACHED_DIRECTORY_PREFIX = 'init-';
const STALE_WORK_DIRECTORY_MS = 24 * 60 * 60 * 1000;

/** Nothing removes a detached scanner's directory, so earlier runs' leftovers go on the next run. */
function pruneStaleWorkDirectories(): void {
  let names: string[];
  try {
    names = readdirSync(CLI_TMP_DIR);
  } catch {
    return;
  }
  for (const name of names.filter((entry) => entry.startsWith(DETACHED_DIRECTORY_PREFIX))) {
    const path = join(CLI_TMP_DIR, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_WORK_DIRECTORY_MS) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch (error) {
      logger.debug(`Could not remove stale scanner directory ${path}: ${(error as Error).message}`);
    }
  }
}

function newWorkDirectory(detached: boolean): string {
  if (!detached) {
    return mkdtempSync(join(tmpdir(), 'sonar-init-'));
  }
  // A background scanner keeps using this directory after `sonar init` has exited.
  mkdirSync(CLI_TMP_DIR, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
  pruneStaleWorkDirectories();
  return mkdtempSync(join(CLI_TMP_DIR, DETACHED_DIRECTORY_PREFIX));
}

/** The project and its mapping exist by now, so a failure has to say they were kept. */
function keepProjectNote(projectKey: string, error: unknown): CommandFailedError {
  const message = error instanceof Error ? error.message : 'unknown error';
  const hint = error instanceof CliError ? error.remediationHint : undefined;
  return new CommandFailedError(`The first analysis did not complete: ${message}`, {
    cause: error,
    remediationHint: [
      `Project '${projectKey}' and ${SHARED_PROJECT_CONFIG_FILE_NAME} were kept, so the setup is intact.`,
      hint,
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

async function readResults(
  deps: DetectDeps,
  projectKey: string,
  analysisId: string,
): Promise<{ qualityGate: QualityGateStatus | null; openIssues: number | null }> {
  const { http, auth } = deps;
  const qualityGate = await new QualityGatesClient(http).getAnalysisStatus(analysisId).match(
    (status) => status.status,
    (error) => {
      logger.debug(`Could not read the quality gate of '${projectKey}': ${error.message}`);
      return null;
    },
  );
  const openIssues = await new IssuesClient(http)
    .searchIssues({
      projects: projectKey,
      organization: auth.orgKey,
      issueStatuses: DEFAULT_STATUSES.join(','),
      ps: 1,
      p: 1,
    })
    .match(
      (result) => result.total,
      (error) => {
        logger.debug(`Could not count the issues of '${projectKey}': ${error.message}`);
        return null;
      },
    );
  return { qualityGate, openIssues };
}

async function confirmScan(console: Console): Promise<boolean> {
  return requireAnswer(
    await console.confirmPrompt('Run the first analysis with sonar-scanner now?', true),
  );
}

/**
 * Offers the first analysis of a freshly created project, downloads the scanner when it is not
 * installed, runs it and reads the results. Non-interactive runs scan only when a scan flag asks
 * for it, since downloading and running a scanner is not something to do unasked.
 */
export async function runFirstScan(
  projectRoot: string,
  projectKey: string,
  deps: DetectDeps,
  flags: ScanFlags,
): Promise<ScanResult> {
  const { auth, console, interactive } = deps;
  if (interactive ? !(await confirmScan(console)) : !scanRequested(flags)) {
    return NOT_RUN;
  }

  let directory: string | undefined;
  let handedOff = false;
  try {
    await assertScannerNetworkUsable(auth.serverUrl, flags.detach);
    const scanner = await installSonarScanner(console);
    directory = newWorkDirectory(flags.detach);
    const run = {
      scanner,
      projectRoot,
      projectKey,
      auth,
      directory,
      networkEnv: await scannerNetworkEnv(
        auth.serverUrl,
        scanner.javaPath,
        directory,
        flags.detach,
      ),
      scannerProperties: flags.scannerProperties,
    };

    if (flags.detach) {
      const background = await startScannerInBackground(run);
      handedOff = true;
      return { status: 'started', ...background };
    }

    const live = flags.verbose
      ? {
          print: (line: string) => {
            console.print(line);
          },
        }
      : undefined;
    const startedAt = Date.now();
    const budgetMs = DEFAULT_ANALYSIS_TIMEOUT_SECONDS * 1000;
    const analyze = () => runScanner(run, live, budgetMs);
    const { taskId, logPath } = live
      ? await analyze()
      : await console.withSpinner('Analyzing source code', analyze);
    const deadline = startedAt + budgetMs;
    const analysisId = await console.withSpinner(
      'Waiting for the server to process the analysis',
      () => new ComputeEngineClient(deps.http).waitForAnalysis(taskId, projectKey, deadline),
    );
    return {
      status: 'completed',
      taskId,
      analysisId,
      logPath,
      ...(await readResults(deps, projectKey, analysisId)),
    };
  } catch (error) {
    throw keepProjectNote(projectKey, error);
  } finally {
    if (directory && !handedOff) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

const GATE_TEXT: Record<QualityGateStatus, string> = {
  OK: 'passed',
  WARN: 'passed with warnings',
  ERROR: 'failed',
  NONE: 'not configured for this project',
};

export function reportScan(scan: ScanResult, projectKey: string, console: Console): void {
  if (scan.status === 'started') {
    console.print(
      `Analysis started in the background (process ${scan.pid}); the results are not known yet.`,
    );
    console.print(`Scanner log: ${scan.logPath}`);
    console.print(`Check the results with: sonar quality-gate status -p ${projectKey}`);
    return;
  }
  if (scan.status !== 'completed') {
    return;
  }
  console.success('Analysis completed.');
  // A failed gate judges the code, not the setup, so it is reported without an error.
  console.print(
    scan.qualityGate === null
      ? 'Quality gate: not available.'
      : `Quality gate: ${GATE_TEXT[scan.qualityGate]}. See: sonar quality-gate status -p ${projectKey}`,
  );
  console.print(
    scan.openIssues === null ? 'Open issues: not available.' : `Open issues: ${scan.openIssues}`,
  );
}
