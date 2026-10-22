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

// Dependency-risks stage of the git pre-commit hook. Invoked after the secrets
// stage when the hook was installed with dependency-risks scanning enabled
// (--dependency-risks, optionally with -p <projectKey>). Skips silently when no
// manifests changed, scans each linked project whose manifests changed, fails-open
// on infra errors (auth/binary missing, scanner failure), and blocks the commit
// only when risks matching the configured filter are found.

import { resolve } from 'node:path';

import { createScaScanApi } from '@/commands/analyze/dependency-risk-helpers/sca-api.ts';
import { SEVERITIES } from '@/commands/analyze/dependency-risk-helpers/view-model/build';
import {
  recordScaAnalysisTelemetry,
  SCA_CALLER_COMMANDS,
} from '@/commands/analyze/sca-analysis-telemetry.ts';
import { recordedConnectionCredentialSource } from '@/core/auth/recorded-connection.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import {
  resolveScaScannerBinaryPath,
  ScaScannerNoopInstaller,
} from '@/core/host/install/sca-scanner.ts';
import { ResolveOnlySecretsInstaller } from '@/core/host/install/secrets.ts';
import { canonicalizePath, isAncestorOrSelf } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import type { CompleteProjectMapping } from '@/core/project-discovery/project-discovery-result.ts';
import {
  assertSingleLineProjectKey,
  discoverProjects,
} from '@/core/project-discovery/project-info.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import type { Console } from '@/core/ui/console.ts';

import { countSelectedRisks } from '../analyze/dependency-risk-helpers/count-selected-risks.ts';
import { DefaultScaScannerSpawner } from '../analyze/dependency-risk-helpers/default-sca-scanner-spawner.ts';
import { pluralize } from '../analyze/dependency-risk-helpers/pluralize.ts';
import {
  buildRiskFilter,
  type RiskFilter,
} from '../analyze/dependency-risk-helpers/risk-filter.ts';
import {
  ScaScanOrchestrator,
  type ScaScanTarget,
} from '../analyze/dependency-risk-helpers/sca-scan-orchestrator.ts';
import type { Severity } from '../analyze/dependency-risk-helpers/sca-scanner.ts';
import {
  ScaWatchPatternsRunner,
  selectMatchingFiles,
} from '../analyze/dependency-risk-helpers/sca-watch-patterns.ts';
import type { DependencyRisksViewModel } from '../analyze/dependency-risk-helpers/view-model';
import { buildDependencyRisksViewModel } from '../analyze/dependency-risk-helpers/view-model/build';

const HOOK_STATUS_FILTER = 'new';
const HOOK_MIN_SEVERITY: Severity = 'MEDIUM';

export interface DepRisksStageOptions {
  /** The hook's baked `-p`, if any. Absent means "discover one", not "there is none". */
  project?: string;
  changedFiles: string[];
  connection: SonarConnection;
  ctx: CommandInvocationContext;
}

interface BlockedProject {
  projectKey: string;
  viewModel: DependencyRisksViewModel;
}

export async function runDepRisksStage(options: DepRisksStageOptions): Promise<void> {
  const { console } = options.ctx;
  const binaryPath = resolveScaScannerBinaryPath();
  if (!binaryPath) {
    logger.warn('Dependency-risks hook: sca-scanner binary not installed, skipping.');
    console.warn(
      "Dependency-risks scan skipped: sca-scanner binary not installed; commit not blocked. Re-run 'sonar integrate git' to restore it.",
    );
    return;
  }

  const changedManifests = await findChangedManifests(binaryPath, options.changedFiles, console);
  if (changedManifests.length === 0) {
    return;
  }

  const targets = await resolveScanTargets(options, changedManifests);
  if (!targets) {
    logger.warn('Dependency-risks hook: no project key resolved, skipping.');
    console.warn(
      'Dependency-risks scan skipped: no SonarQube project resolved for this repo; ' +
        "commit not blocked. Run 'sonar link <projectKey>' to link one to this repository.",
    );
    return;
  }
  if (targets.length === 0) {
    return;
  }
  if (targets.length === 1) {
    noteProject(options.connection.auth, targets[0].projectKey);
  }

  const filter = buildRiskFilter(HOOK_STATUS_FILTER, HOOK_MIN_SEVERITY);
  if (!filter) {
    console.warn(
      `Dependency-risks hook: invalid filter (statuses='${HOOK_STATUS_FILTER}'); commit not blocked.`,
    );
    return;
  }

  const blocked: BlockedProject[] = [];
  let scannedCount = 0;
  // One scan at a time: each spawns a heavy sca-scanner, and the progress lines must match it.
  for (const [index, target] of targets.entries()) {
    const isMultiProject = targets.length > 1;
    if (isMultiProject) {
      console.info(
        `Scanning dependency risks for ${target.projectKey} (${index + 1}/${targets.length})`,
        'stderr',
      );
    }
    const viewModel = await scanProject(binaryPath, target, filter, options, isMultiProject);
    if (!viewModel) {
      continue;
    }
    scannedCount++;
    if (countSelectedRisks(viewModel) > 0) {
      blocked.push({ projectKey: target.projectKey, viewModel });
    }
  }

  if (blocked.length > 0) {
    throw blockedCommitError(blocked, targets.length > 1);
  }
  if (scannedCount > 0) {
    console.discreetSuccess('No dependency risks found.');
  }
}

/** Fail-open: a scan failure warns and yields no view model. */
async function scanProject(
  binaryPath: string,
  target: ScaScanTarget,
  filter: RiskFilter,
  options: DepRisksStageOptions,
  isMultiProject: boolean,
): Promise<DependencyRisksViewModel | undefined> {
  try {
    const client = createScaScanApi(options.connection.httpClient);
    const scan = await new ScaScanOrchestrator(
      client,
      new ScaScannerNoopInstaller(binaryPath),
      new DefaultScaScannerSpawner(),
      new ResolveOnlySecretsInstaller(),
    ).run(options.connection.auth, target, SCA_CALLER_COMMANDS.gitPreCommit, options.ctx);
    const viewModel = buildDependencyRisksViewModel(scan.response, filter);
    // Hook has no analyze-style 0/1/51 exit code, so exit_code is null.
    recordScaAnalysisTelemetry(
      options.ctx,
      options.connection.auth,
      SCA_CALLER_COMMANDS.gitPreCommit,
      scan.response,
      scan.scanDurationMs,
      null,
    );
    return viewModel;
  } catch (err) {
    // The orchestrator already emitted a failures_count:1 event if the SCA scan itself failed;
    // a secrets pre-scan abort also lands here and must NOT be recorded as an SCA failure.
    const subject = isMultiProject ? ` for ${target.projectKey}` : '';
    options.ctx.console.warn(
      `Dependency-risks scan failed${subject}; commit not blocked. Reason: ${(err as Error).message}`,
    );
    return undefined;
  }
}

/**
 * `undefined` when no project resolves. With `.sonar-config.json`, only the linked projects
 * holding a changed manifest are scanned, each from its own root.
 */
async function resolveScanTargets(
  options: DepRisksStageOptions,
  changedManifests: string[],
): Promise<ScaScanTarget[] | undefined> {
  const { auth } = options.connection;
  const { console } = options.ctx;
  // Git runs hooks from the top level of the worktree, which staged paths are relative to.
  const cwd = canonicalizePath(process.cwd());

  if (options.project) {
    assertSingleLineProjectKey(options.project);
    const discovered = await discoverProjects(cwd, {
      auth,
      silent: true,
      console,
      useGitRemoteBinding: false,
    });
    const linked = discovered.projects.find((project) => project.projectKey === options.project);
    return [{ projectKey: options.project, baseDir: linked?.projectRoot ?? cwd }];
  }

  const discovered = await discoverProjects(cwd, { auth, silent: true, console });
  const scoped = discovered.scope(cwd);
  if (scoped.length === 0) {
    return undefined;
  }
  for (const { projectKey } of scoped) {
    assertSingleLineProjectKey(projectKey);
  }
  if (!discovered.fromSharedConfig) {
    const [{ projectKey, projectRoot }] = scoped;
    return [{ projectKey, baseDir: projectRoot }];
  }

  const manifestPaths = changedManifests.map((file) => resolve(cwd, file));
  const changed = scoped.filter((project) =>
    manifestPaths.some((path) => isAncestorOrSelf(project.projectRoot, path)),
  );
  if (changed.length === 0) {
    console.success(
      'No dependency manifests changed in a linked project, skipping dependency-risks scan.',
    );
    return [];
  }

  return changed
    .filter((project) =>
      isScannable(project, discovered.scope(project.projectRoot).length, options),
    )
    .map(({ projectKey, projectRoot }) => ({ projectKey, baseDir: projectRoot }));
}

function isScannable(
  project: CompleteProjectMapping,
  projectsOnItsPath: number,
  options: DepRisksStageOptions,
): boolean {
  const { console } = options.ctx;
  if (projectsOnItsPath > 1) {
    console.warn(
      `Dependency-risks scan skipped for ${project.projectKey}: nested projects are not supported yet; commit not blocked.`,
    );
    return false;
  }
  const { serverUrl, organization } = project;
  if (
    recordedConnectionCredentialSource(options.connection.auth, serverUrl, organization) !==
    'active'
  ) {
    console.warn(
      `Dependency-risks scan skipped for ${project.projectKey}: it is linked to a connection other than the active one; commit not blocked.`,
    );
    return false;
  }
  return true;
}

function blockedCommitError(
  blocked: BlockedProject[],
  isMultiProject: boolean,
): CommandFailedError {
  const total = blocked.reduce((sum, { viewModel }) => sum + countSelectedRisks(viewModel), 0);
  const breakdown = isMultiProject
    ? `: ${blocked.map((project) => formatProjectBreakdown(project)).join(', ')}`
    : ` (${formatSeverityBreakdown(blocked[0].viewModel)})`;
  const commands = blocked
    .map(({ projectKey }) => `'sonar analyze dependency-risks -p ${projectKey}'`)
    .join(', ');
  return new CommandFailedError(
    `${total} dependency ${pluralize(total, 'risk')} found${breakdown}`,
    {
      remediationHint: `Run ${commands} for details and fix recommendations. Bypass with 'git commit --no-verify' if risks are already reviewed.`,
    },
  );
}

function formatProjectBreakdown({ projectKey, viewModel }: BlockedProject): string {
  return `${projectKey} (${formatSeverityBreakdown(viewModel)})`;
}

function formatSeverityBreakdown(viewModel: DependencyRisksViewModel): string {
  return SEVERITIES.map((severity) => ({
    severity,
    count: countSelectedRisks(viewModel, (risk) => risk.severity === severity),
  }))
    .filter(({ count }) => count > 0)
    .map(({ severity, count }) => `${count} ${severity}`)
    .join(', ');
}

async function findChangedManifests(
  binaryPath: string,
  changedFiles: string[],
  console: Console,
): Promise<string[]> {
  const patterns = await new ScaWatchPatternsRunner(
    new ScaScannerNoopInstaller(binaryPath),
    new DefaultScaScannerSpawner(),
  ).run();
  if (patterns.length === 0) {
    logger.debug('Dependency-risks hook: no watch patterns returned, skipping.');
    return [];
  }

  const changedManifests = selectMatchingFiles(changedFiles, patterns);
  if (changedManifests.length === 0) {
    console.success(
      'No dependency manifests changed in this commit, skipping dependency-risks scan.',
    );
  }
  return changedManifests;
}
