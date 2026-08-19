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

import type { CliAuthenticatedContext } from '@/commands/cli-context.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import { runWithConcurrencyLimit } from '@/core/concurrency/concurrency-pool.ts';
import {
  type DopRepository,
  type ProvisionedProject,
  SonarQubeClient,
} from '@/core/server/client.ts';
import { info, intro, outro } from '@/core/ui';
import { ImportProgress } from '@/core/ui/components/import-progress.ts';

import type {
  OnlyPrivateProjects,
  RepositoryCollection,
  SkippedRepo,
} from './_common/repository-collection';
import {
  assertSupportedAlm,
  computeInstallationKey,
  type RepoResolution,
  resolveAlmKey,
  type ResolvedRepo,
  resolveOrg,
  resolveRepos,
} from './_common/resolve-options';
import type { ImportOptions } from './_common/types';

export { type ImportOptions } from './_common/types';

/** Max number of `provision_projects` calls run concurrently. */
const IMPORT_PROVISION_CONCURRENCY_LIMIT = 10;

/** Resolves the org tied to the active connection, then the repos to import into it. */
async function resolveOrgAndRepos(
  client: SonarQubeClient,
  orgKey: string | undefined,
  options: ImportOptions,
): Promise<{ orgKey: string; almKey: string | undefined } & RepoResolution> {
  const {
    key: resolvedOrgKey,
    almKey: resolvedAlmKey,
    onlyPrivateProjectsEnabled,
  } = await resolveOrg(client, orgKey);

  info(`Organization: ${resolvedOrgKey}`);

  const [almKey, privateProjectsAvailable] = await Promise.all([
    resolveAlmKey(client, resolvedOrgKey, resolvedAlmKey),
    client.hasPrivateProjectsEntitlement(resolvedOrgKey),
  ]);

  // Before any repository is listed, so an unsupported org stops here rather than after a full
  // paginated fetch.
  assertSupportedAlm(resolvedOrgKey, almKey);

  const onlyPrivateProjects: OnlyPrivateProjects = {
    enabled: onlyPrivateProjectsEnabled ?? false,
    available: privateProjectsAvailable,
  };

  const outcome = await resolveRepos(client, resolvedOrgKey, almKey, onlyPrivateProjects, options);

  return { orgKey: resolvedOrgKey, almKey, ...outcome };
}

/** Builds the `runWithConcurrencyLimit` task that provisions one repo and updates `progress`. */
function createProvisionTask(
  client: SonarQubeClient,
  orgKey: string,
  progress: ImportProgress,
): (repo: ResolvedRepo) => Promise<ProvisionedProject> {
  return async (repo) => {
    progress.update(repo.slug, 'running');
    try {
      const result = await client.provisionProject(orgKey, repo.installationKey);
      if (result.projects.length === 0) {
        throw new Error(
          'provision_projects returned no project — the repository may already be bound, or ' +
            'the installation key was rejected by the server.',
        );
      }
      const project = result.projects[0];
      await client.requestAutoscanEligibility(project.projectKey);
      progress.update(repo.slug, 'done');
      return project;
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
  client: SonarQubeClient,
  orgKey: string,
  almKey: string | undefined,
  collection: RepositoryCollection,
  regex: RegExp | undefined,
): Promise<{ succeeded: number; failed: number; skipped: readonly SkippedRepo[] }> {
  const progress = new ImportProgress({ maxVisible: IMPORT_PROVISION_CONCURRENCY_LIMIT });
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
    const repos: ResolvedRepo[] = toImport.map((repo) => ({
      slug: repo.slug,
      installationKey: computeInstallationKey(repo, almKey),
    }));
    progress.addRepos(repos.map((repo) => repo.slug));
    await runWithConcurrencyLimit(
      repos,
      IMPORT_PROVISION_CONCURRENCY_LIMIT,
      createProvisionTask(client, orgKey, progress),
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

function reportSkipped(skipped: readonly SkippedRepo[]): void {
  if (skipped.length === 0) return;
  info(`Repositories skipped: ${skipped.length}`);
  const countsByReason = new Map<string, number>();
  for (const s of skipped) {
    countsByReason.set(s.reason, (countsByReason.get(s.reason) ?? 0) + 1);
  }
  for (const [reason, count] of countsByReason) {
    info(`  - ${reason}: ${count}`);
  }
}

/** Builds the SonarQube Cloud onboarding dashboard link for an organization. */
function buildOnboardingDashboardUrl(serverUrl: string, orgKey: string): string {
  return `${serverUrl.replace(/\/$/, '')}/organizations/${orgKey}/onboarding-dashboard`;
}

function reportOutcome(
  succeeded: number,
  failed: number,
  skippedCount: number,
  dashboardUrl: string,
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
  outro(
    `Imported ${succeeded} ${succeededNoun}${skippedSuffix}`,
    'success',
    `Dashboard: ${dashboardUrl}`,
  );
}

export async function importHandler(
  options: ImportOptions,
  ctx: CliAuthenticatedContext,
): Promise<void> {
  const { auth } = ctx;
  const client = new SonarQubeClient(auth.serverUrl, auth.token);

  intro('Import repositories', 'SonarQube');

  const resolution = await resolveOrgAndRepos(client, auth.orgKey, options);

  if (resolution.kind === 'streaming') {
    const { succeeded, failed, skipped } = await runBulkImportJob(
      client,
      resolution.orgKey,
      resolution.almKey,
      resolution.collection,
      resolution.regex,
    );
    reportSkipped(skipped);
    reportOutcome(
      succeeded,
      failed,
      skipped.length,
      buildOnboardingDashboardUrl(auth.serverUrl, resolution.orgKey),
    );
    return;
  }

  const { repos, skipped } = resolution;

  info(`Repositories to import: ${repos.length}`);
  reportSkipped(skipped);

  const progress = new ImportProgress({ maxVisible: IMPORT_PROVISION_CONCURRENCY_LIMIT });
  progress.setTotal(repos.length);
  progress.addRepos(repos.map((repo) => repo.slug));
  progress.start();

  await runWithConcurrencyLimit(
    repos,
    IMPORT_PROVISION_CONCURRENCY_LIMIT,
    createProvisionTask(client, resolution.orgKey, progress),
  );

  const { succeeded, failed } = progress.finish();
  reportOutcome(
    succeeded,
    failed,
    skipped.length,
    buildOnboardingDashboardUrl(auth.serverUrl, resolution.orgKey),
  );
}
