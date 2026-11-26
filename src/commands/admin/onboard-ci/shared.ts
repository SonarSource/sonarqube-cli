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

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import type { SonarCommand } from '@/core/commands/sonar-command.ts';
import { runWithConcurrencyLimit } from '@/core/concurrency/concurrency-pool.ts';
import type { DevOpsPlatform } from '@/core/devops/token.ts';
import type { ComponentsClient } from '@/core/server/components.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';
import { UsersClient } from '@/core/server/users.ts';
import { ConcurrentProgress } from '@/core/ui/components/concurrent-progress.ts';
import type { Console } from '@/core/ui/console.ts';

import type { RepoOutcome, RepoRunResults } from './types.ts';

const CONCURRENCY_LIMIT = 10;
const SKIP_MESSAGES: Partial<Record<string, string>> = {
  NOT_IN_SONARQUBE: 'skipped (not bound in SonarQube)',
  MULTIPLE_PROJECT_KEYS: 'skipped (repository is bound to multiple SonarQube project keys)',
  ALREADY_CONFIGURED: 'skipped (already configured)',
  ALREADY_ANALYZED: 'skipped (already analyzed)',
  PR_ALREADY_OPEN: 'skipped (PR already open)',
  MR_ALREADY_OPEN: 'skipped (MR already open)',
  OTHER_CI_DETECTED: 'skipped (other CI detected)',
  UNSUPPORTED_REPOSITORY: 'skipped (unsupported repository)',
  WORKFLOW_COLLISION: 'skipped (SonarQube workflow already exists)',
  UNSUPPORTED_WORKFLOW: 'skipped (unsupported workflow file)',
};

export const REPORT_FILE = 'sonar-onboard-ci-report.json';
export const DRY_RUN_REPORT_FILE = 'sonar-onboard-ci-report-dry.json';

export function addOnboardCiOptions(
  command: SonarCommand,
  options: {
    reposFileDescription: string;
    pullRequestTrigger: 'mr' | 'pr';
  },
): SonarCommand {
  return command
    .option(
      '--binding-name <name>',
      'Name of the DevOps platform configuration in SonarQube (auto-detected if only one exists)',
    )
    .option('--repos-file <file>', options.reposFileDescription)
    .option(
      '--sonar-token-var-name <name>',
      'Name of the existing CI secret or variable holding the SonarQube analysis token; uses SONAR_TOKEN when omitted',
    )
    .option(
      '--trigger-on <events>',
      `CI triggers: ${options.pullRequestTrigger} | main | both; uses both when omitted`,
    )
    .option(
      '--scanner-property <key=value>',
      'Additional scanner property to inject into the CI configuration (repeatable; e.g. --scanner-property sonar.exclusions=**/*.test.ts)',
      collectScannerProperty,
    )
    .option('--dry-run', 'Preview what would be processed without making any changes', false);
}

export function collectScannerProperty(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function assertOnPremiseConnection(auth: ResolvedAuth, platform: DevOpsPlatform): void {
  if (auth.connectionType !== 'on-premise') {
    throw new CommandFailedError(
      `sonar admin onboard-ci ${platform.toLowerCase()} requires a SonarQube Server connection.`,
      {
        remediationHint: "Authenticate against SonarQube Server with 'sonar auth login' and retry.",
      },
    );
  }
}

export async function assertProvisionProjectsPermission(client: SonarHttpClient): Promise<void> {
  if (!(await new UsersClient(client).hasProvisionProjectsPermission().orThrow())) {
    throw new CommandFailedError(
      'This command requires the "Provision Projects" global permission in SonarQube.',
    );
  }
}

export function readOptionFile(path: string, flag: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new InvalidOptionError(`${flag}: file not found or unreadable: ${path}`);
  }
}

export function readReposFile(path: string): Set<string> {
  return new Set(
    readOptionFile(path, '--repos-file')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );
}

export async function runRepos<Repo>(
  repos: Repo[],
  repoName: (repo: Repo) => string,
  processRepo: (repo: Repo, progress: ConcurrentProgress) => Promise<RepoOutcome>,
  requestLabel: 'PR' | 'MR',
  console: Console,
): Promise<RepoRunResults> {
  const results: RepoRunResults = { opened: [], wouldOpen: [], skipped: [], failed: [] };
  const progress = new ConcurrentProgress({
    console,
    maxVisible: CONCURRENCY_LIMIT,
    showResult: false,
  });
  progress.setTotal(repos.length);
  progress.addItems(repos.map(repoName));
  progress.start();
  await runWithConcurrencyLimit(repos, CONCURRENCY_LIMIT, async (repo) => {
    const name = repoName(repo);
    progress.update(name, 'running');
    try {
      const result = await processRepo(repo, progress);
      switch (result.outcome) {
        case 'proceed':
          results.wouldOpen.push({ repo: name, projectKey: result.projectKey });
          progress.update(name, 'done', `would open ${requestLabel}`);
          break;
        case 'opened':
          results.opened.push({ repo: name, projectKey: result.projectKey, prUrl: result.prUrl });
          progress.update(name, 'done', `${requestLabel} opened`);
          break;
        case 'skip':
          results.skipped.push({ repo: name, reason: result.reason, prUrl: result.prUrl });
          progress.update(
            name,
            'done',
            result.message ?? SKIP_MESSAGES[result.reason] ?? result.reason,
          );
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.failed.push({ repo: name, error: message });
      progress.update(name, 'failed', message);
    }
  });
  progress.finish();
  return results;
}

export function finishOnboarding(
  results: RepoRunResults,
  report: object,
  requestLabel: 'PR' | 'MR',
  console: Console,
  dryRun = false,
): void {
  const opened = (dryRun ? results.wouldOpen : results.opened).length.toLocaleString();
  const skipped = results.skipped.length.toLocaleString();
  const failed = results.failed.length;
  const message = dryRun
    ? `Would open ${opened} ${requestLabel}s · skip ${skipped} · fail ${failed.toLocaleString()}`
    : `Opened ${opened} ${requestLabel}s · ${skipped} skipped · ${failed.toLocaleString()} failed`;
  console.outro(message, failed ? 'error' : 'success', dryRun ? 'No changes were made' : undefined);
  writeReportFile(report, dryRun ? DRY_RUN_REPORT_FILE : REPORT_FILE, console);
  if (failed) {
    throw new CommandFailedError(`${failed} repositories failed to process.`, {
      remediationHint: 'See the per-repository errors above and the report file for details.',
    });
  }
}

export function writeReportFile(results: object, filename: string, console: Console): void {
  const dest = join(process.cwd(), filename);
  try {
    writeFileSync(dest, JSON.stringify(results, null, 2), 'utf8');
  } catch (err) {
    throw new CommandFailedError(`Failed to write report to ${dest}: ${String(err)}`);
  }
  console.print(`Full report: ${filename}  (written to current directory)`);
}

export async function hasExistingProjectAnalysis(
  components: ComponentsClient,
  projectKey: string,
): Promise<boolean> {
  // Analysis history alone cannot distinguish a missing project from an unanalyzed one.
  if (!(await components.componentExists(projectKey).orThrow())) {
    throw new CommandFailedError(
      `Bound SonarQube project '${projectKey}' is missing or inaccessible.`,
    );
  }
  return components.hasProjectBeenAnalyzed(projectKey).orThrow();
}
