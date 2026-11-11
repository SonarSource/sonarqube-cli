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
import { type MonorepoProject, resolveMonorepoImport } from './monorepo-projects.ts';
import type { RepositoryCollection, SkippedRepo } from './repository-collection';
import type { ResolvedRepo } from './resolve-options';
import { ServerImportApiClient } from './server/server-import-api.ts';
import { ServerBackend } from './server-backend.ts';
import type { ImportOptions, ImportPlanOptions } from './types';

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
      progress.update(repo.slug, 'done', outcome?.detail);
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
export async function runBulkImportJob(
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
      page = await collection.loadMore(); // NOSONAR: sequential by design, each page continues from the previous one
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
    progress.setTotal(collection.total);
    await importPage(page.eligible); // NOSONAR: sequential by design, a page is imported before the next is fetched
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
  outroLink: ImportPlan['outroLink'],
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
    `${outroLink.label}: ${outroLink.url}`,
  );
}

const noun = (count: number): string => (count === 1 ? 'project' : 'projects');

/** Announces what is already bound, skipped or in conflict; returns whether it said anything. */
function warnAboutExistingProjects(
  console: Console,
  repo: ResolvedRepo,
  bound: { keys: string[]; elsewhere: number },
  skippedKeys: string[],
  conflictKeys: string[],
): boolean {
  const notices: string[] = [];
  if (bound.keys.length > 0) {
    notices.push(
      `${bound.keys.length} ${noun(bound.keys.length)} already bound to ${repo.slug}: ${bound.keys.join(', ')}`,
    );
  }
  if (bound.elsewhere > 0) {
    notices.push(
      `${bound.elsewhere} more ${noun(bound.elsewhere)} bound to ${repo.slug} not visible in this organization.`,
    );
  }
  if (skippedKeys.length > 0) {
    notices.push(
      `${skippedKeys.length} requested ${noun(skippedKeys.length)} already ${skippedKeys.length === 1 ? 'exists' : 'exist'} and will be skipped: ${skippedKeys.join(', ')}`,
    );
  }
  if (conflictKeys.length > 0) {
    const one = conflictKeys.length === 1;
    notices.push(
      `${conflictKeys.length} requested ${noun(conflictKeys.length)} already ${one ? 'exists' : 'exist'} but ${one ? 'is' : 'are'} not bound to ${repo.slug}; the import will report ${one ? 'it' : 'them'} as failed: ${conflictKeys.join(', ')}`,
    );
  }
  for (const notice of notices) console.warn(` ${notice}`);
  return notices.length > 0;
}

/**
 * Splits `projects` into those to send to the backend and the keys to skip. Only a key that exists
 * and is already bound to `repo` is skipped; a key that exists but is not bound to it (taken by
 * another project) stays in the import so the backend reports that conflict as a failure. Skipped
 * keys are announced before anything is created, and an interactive user decides whether to go on.
 */
async function selectNewProjects(
  plan: ImportPlan,
  repo: ResolvedRepo,
  projects: MonorepoProject[],
  console: Console,
): Promise<{ toImport: MonorepoProject[]; skippedKeys: string[] }> {
  const existing = new Set(
    await plan.findExistingProjectKeys(
      repo,
      projects.map(({ projectKey }) => projectKey),
    ),
  );
  const bound = await plan.listBoundProjectKeys(repo);
  const boundKeys = new Set(bound.keys);
  const skippedKeys = projects
    .filter((p) => existing.has(p.projectKey) && boundKeys.has(p.projectKey))
    .map((p) => p.projectKey);
  const conflictKeys = projects
    .filter((p) => existing.has(p.projectKey) && !boundKeys.has(p.projectKey))
    .map((p) => p.projectKey);
  const toImport = projects.filter((p) => !skippedKeys.includes(p.projectKey));
  const warned = warnAboutExistingProjects(console, repo, bound, skippedKeys, conflictKeys);
  if (!warned) {
    return { toImport, skippedKeys };
  }
  if (toImport.length > 0 && console.canPrompt()) {
    const proceed = await console.confirmPrompt(
      `Import the other ${toImport.length} ${noun(toImport.length)} (${toImport.map((p) => p.projectKey).join(', ')})?`,
      true,
    );
    if (!proceed) {
      throw new CommandFailedError('Monorepo import cancelled; nothing was created.');
    }
  }
  return { toImport, skippedKeys };
}

/** Binds the not-yet-existing `projects` to the single repository the plan resolved, then reports per project. */
async function runMonorepoImport(
  plan: ImportPlan,
  projects: MonorepoProject[],
  console: Console,
): Promise<void> {
  const { selection } = plan;
  if (selection.kind !== 'batch' || selection.repos.length !== 1) {
    throw new CommandFailedError('A monorepo import needs exactly one resolved repository.');
  }
  const [repo] = selection.repos;
  console.info(`Repository: ${repo.slug}`);

  const { toImport, skippedKeys } = await selectNewProjects(plan, repo, projects, console);
  if (toImport.length === 0) {
    console.outro(
      `Nothing to import: every project already exists (${skippedKeys.join(', ')})`,
      'success',
    );
    return;
  }

  const progress = new ImportProgress({
    console,
    maxVisible: IMPORT_PROVISION_CONCURRENCY_LIMIT,
  });
  progress.setTotal(toImport.length);
  progress.addRepos(toImport.map((project) => project.projectKey));
  progress.start();

  const bound = new Set<string>();
  try {
    await plan.importMonorepo(repo, toImport, (projectKey, status, detail) => {
      if (status === 'done') bound.add(projectKey);
      progress.update(projectKey, status, detail);
    });
  } catch (error) {
    progress.finish();
    throw error;
  }

  const { succeeded, failed } = progress.finish();
  if (skippedKeys.length > 0) {
    console.info(`Skipped (already exist): ${skippedKeys.join(', ')}`);
  }
  const projectLinks = toImport
    .filter(({ projectKey }) => bound.has(projectKey))
    .map(({ projectKey }) => `${projectKey}: ${plan.projectUrl(projectKey)}`);
  if (failed > 0) {
    // Keep the links of the projects that did get bound; the error alone would hide them.
    if (projectLinks.length > 0) {
      console.info(`Bound:\n${projectLinks.join('\n')}`);
    }
    throw new CommandFailedError(
      succeeded === 0
        ? `Failed to bind ${failed} ${noun(failed)} to ${repo.slug}.`
        : `Bound ${succeeded} of ${succeeded + failed} projects to ${repo.slug} (${failed} failed).`,
      { remediationHint: 'See the per-project errors above for details.' },
    );
  }
  const skippedSuffix = skippedKeys.length > 0 ? ` (${skippedKeys.length} skipped)` : '';
  console.outro(
    `Bound ${succeeded} ${noun(succeeded)} to ${repo.slug}${skippedSuffix}`,
    'success',
    projectLinks.join('\n'),
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
  const monorepo = resolveMonorepoImport(options);
  // The repository resolves like an explicit `--repo`, so every check on it stays shared.
  const effective: ImportPlanOptions = monorepo
    ? { ...options, repo: [monorepo.repo], allowImportedRepo: true }
    : options;
  console.intro('Import repositories', 'SonarQube');

  const plan = await createBackend(effective, ctx).plan(effective, console);
  if (monorepo) {
    await runMonorepoImport(plan, monorepo.projects, console);
    return;
  }
  const { selection, outroLink } = plan;

  if (selection.kind === 'streaming') {
    const { succeeded, failed, skipped } = await runBulkImportJob(
      plan,
      selection.collection,
      selection.regex,
      console,
    );
    reportSkipped(skipped, console);
    if (selection.collection.incomplete) {
      const succeededNoun = succeeded === 1 ? 'repository' : 'repositories';
      throw new CommandFailedError(
        `Repository discovery was incomplete. Imported ${succeeded} ${succeededNoun} from the discovered subset (${failed} failed, ${skipped.length} skipped).`,
        {
          remediationHint:
            'Use --repo owner/repository to import repositories beyond the GitHub search limit.',
        },
      );
    }
    reportOutcome(succeeded, failed, skipped.length, outroLink, console);
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
  reportOutcome(succeeded, failed, skipped.length, outroLink, console);
}
