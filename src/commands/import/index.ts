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

import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { runWithConcurrencyLimit } from '@/core/concurrency/concurrency-pool.ts';
import type { Console } from '@/core/ui/console.ts';

import { CloudBackend } from './cloud-backend.ts';
import { type DopRepository, ImportApiClient } from './import-api.ts';
import type { ImportBackend, ImportPlan } from './import-backend.ts';
import { ImportProgress } from './import-progress.ts';
import type { RepositoryCollection, SkippedRepo } from './repository-collection';
import type { ResolvedRepo } from './resolve-options';
import { ServerImportApiClient } from './server/server-import-api.ts';
import { ServerBackend } from './server-backend.ts';
import type { ImportOptions } from './types';

export { type ImportOptions } from './types';

/** Max number of `provision_projects` calls run concurrently. */
const IMPORT_PROVISION_CONCURRENCY_LIMIT = 10;

/** Builds the `runWithConcurrencyLimit` task that imports one repo and updates `progress`. */
function createProvisionTask(
  plan: ImportPlan,
  progress: ImportProgress,
): (repo: ResolvedRepo) => Promise<void> {
  return async (repo) => {
    progress.update(repo.slug, 'running');
    try {
      const outcome = await plan.importRepo(repo);
      progress.update(repo.slug, 'done', outcome.detail);
    } catch (err) {
      progress.update(repo.slug, 'failed', err instanceof Error ? err.message : String(err));
      throw err;
    }
  };
}

/**
 * Runs `--all`/"Recommended" or `--regex`/"By pattern" as a streaming job: import each server
 * page's eligible repos as soon as it's fetched, then fetch the next page — rather than
 * resolving the whole org's repo list before provisioning anything.
 *
 * `regex`, when set, is applied here, live, against each page's already-eligible repos, rather
 * than being baked into `RepositoryCollection`'s own categorization — it's only known once
 * "By pattern" (or `--regex`) is actually chosen, well after the collection was built to check
 * eligibility. A repo is imported only if `regex` is undefined (no filter — `--all`/"Recommended")
 * or matches its name.
 */
async function runBulkImportJob(
  plan: ImportPlan,
  collection: RepositoryCollection,
  regex: RegExp | undefined,
  console: Console,
): Promise<{ succeeded: number; failed: number; skipped: readonly SkippedRepo[] }> {
  const progress = new ImportProgress({
    console,
    maxVisible: IMPORT_PROVISION_CONCURRENCY_LIMIT,
  });
  progress.setTotal(collection.total);
  progress.start();

  const skippedByRegex: SkippedRepo[] = [];

  const importPage = async (eligible: readonly DopRepository[]): Promise<void> => {
    const toImport = eligible.filter((repo) => {
      if (!regex || regex.test(repo.name)) return true;
      skippedByRegex.push({ slug: repo.slug, reason: 'name does not match --regex pattern' });
      return false;
    });
    if (toImport.length < eligible.length) {
      progress.recordSkipped(eligible.length - toImport.length);
    }
    if (toImport.length === 0) return;
    const repos = toImport.map((repo) => plan.toResolvedRepo(repo));
    progress.addRepos(repos.map((repo) => repo.slug));
    await runWithConcurrencyLimit(
      repos,
      IMPORT_PROVISION_CONCURRENCY_LIMIT,
      createProvisionTask(plan, progress),
    );
  };

  // `RepositoryCollection.create` already loaded the first eligible-or-exhausted window before
  // handing the collection here — import it before fetching any further pages.
  progress.recordSkipped(collection.skippedRepos.length);
  await importPage(collection.eligibleRepos);

  while (collection.hasMore) {
    let page;
    try {
      page = await collection.loadMore();
    } catch (err) {
      // A later page's fetch failure still leaves earlier pages' provisioning results behind —
      // finish the display so they're reported, same as any other partial-failure exit.
      progress.finish();
      throw new CommandFailedError(
        `Failed to load repositories: ${err instanceof Error ? err.message : String(err)}`,
        { remediationHint: 'Check your network connection and authentication, then retry.' },
      );
    }
    progress.recordSkipped(page.skipped.length);
    await importPage(page.eligible);
  }

  const { succeeded, failed } = progress.finish();
  return { succeeded, failed, skipped: [...collection.skippedRepos, ...skippedByRegex] };
}

function reportSkipped(skipped: readonly SkippedRepo[], console: Console): void {
  if (skipped.length === 0) return;
  console.info(`Repositories skipped: ${skipped.length}`);
  const countsByReason = new Map<string, number>();
  for (const s of skipped) {
    countsByReason.set(s.reason, (countsByReason.get(s.reason) ?? 0) + 1);
  }
  for (const [reason, count] of countsByReason) {
    console.info(`  - ${reason}: ${count}`);
  }
}

function reportOutcome(
  succeeded: number,
  failed: number,
  skippedCount: number,
  projectListUrl: string,
  console: Console,
): void {
  const skippedSuffix = skippedCount > 0 ? ` (${skippedCount} skipped)` : '';

  if (failed > 0) {
    const failedNoun = failed === 1 ? 'repository' : 'repositories';
    const message =
      succeeded === 0
        ? `Failed to import ${failed} ${failedNoun}.`
        : `Imported ${succeeded} of ${succeeded + failed} repositories (${failed} failed)${skippedSuffix}.`;
    throw new CommandFailedError(message, {
      remediationHint: 'See the per-repository errors above for details.',
    });
  }

  const succeededNoun = succeeded === 1 ? 'repository' : 'repositories';
  console.outro(
    `Imported ${succeeded} ${succeededNoun}${skippedSuffix}`,
    'success',
    `Projects: ${projectListUrl}`,
  );
}

function createBackend(
  options: ImportOptions,
  ctx: CommandAuthenticatedInvocationContext,
): ImportBackend {
  const { httpClient } = ctx.connection;
  if (!httpClient.isCloud) {
    return new ServerBackend(
      new ServerImportApiClient(httpClient, ctx.auth.serverUrl),
      ctx.auth.serverUrl,
    );
  }
  if (options.dopSetting !== undefined) {
    throw new InvalidOptionError(
      '--dop-setting is only supported on SonarQube Server.',
      'Remove --dop-setting, or connect to a SonarQube Server with "sonar auth login".',
    );
  }
  return new CloudBackend(new ImportApiClient(httpClient), ctx.auth.orgKey, ctx.auth.serverUrl);
}

export async function importHandler(
  options: ImportOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { console } = ctx;
  console.intro('Import repositories', 'SonarQube');

  const plan = await createBackend(options, ctx).plan(options, console);
  const { selection, projectListUrl } = plan;

  if (selection.kind === 'streaming') {
    const { succeeded, failed, skipped } = await runBulkImportJob(
      plan,
      selection.collection,
      selection.regex,
      console,
    );
    reportSkipped(skipped, console);
    reportOutcome(succeeded, failed, skipped.length, projectListUrl, console);
    return;
  }

  const { repos, skipped } = selection;

  console.info(`Repositories to import: ${repos.length}`);
  reportSkipped(skipped, console);

  const progress = new ImportProgress({
    console,
    maxVisible: IMPORT_PROVISION_CONCURRENCY_LIMIT,
  });
  progress.setTotal(repos.length);
  progress.addRepos(repos.map((repo) => repo.slug));
  progress.start();

  await runWithConcurrencyLimit(
    repos,
    IMPORT_PROVISION_CONCURRENCY_LIMIT,
    createProvisionTask(plan, progress),
  );

  const { succeeded, failed } = progress.finish();
  reportOutcome(succeeded, failed, skipped.length, projectListUrl, console);
}
