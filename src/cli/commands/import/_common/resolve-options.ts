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

import { type DopRepository, type SonarQubeClient } from '../../../../sonarqube/client';
import {
  confirmPrompt,
  type MultiSelectOption,
  multiSelectPrompt,
  selectPrompt,
  warn,
  withSpinner,
} from '../../../../ui';
import { CommandFailedError, InvalidOptionError } from '../../_common/error';
import { OrganizationCollection } from './organization-collection';
import {
  type FetchPage,
  isAlreadyImported,
  iterateRepoPages,
  type OnlyPrivateProjects,
  RepositoryCollection,
  type SkippedRepo,
} from './repository-collection';

/** ALM key used by GitHub-bound organizations, per `Organization.alm.key`. */
const GITHUB_ALM_KEY = 'github';

export interface ResolvedOrg {
  key: string;
  /** Undefined if no org matches `key`, or the org has no DevOps platform connected. */
  almKey?: string;
  /**
   * `Organization.onlyPrivateProjects.enabled`. Undefined if no org matches `key` — a
   * network/API failure resolving the org is NOT folded into this, it throws instead (see
   * `resolveOrg`'s `--org` branch), so callers can safely default this to `false` (no
   * restriction) without silently disabling visibility enforcement on a transient error. The
   * `available` half of `OnlyPrivateProjects` comes from a separate billing entitlement
   * check, not from here.
   */
  onlyPrivateProjectsEnabled?: boolean;
}

export interface ResolvedRepo {
  slug: string;
  /** ALM-specific identifier expected by `provision_projects`' `installationKeys` param. */
  installationKey: string;
}

/**
 * Outcome of resolving which repositories to import:
 * - `streaming` — `--all`/"Recommended" hand back the live `RepositoryCollection` itself so the
 *   caller can run the fetch-a-page/import-a-page job (see `runBulkImportJob` in `index.ts`)
 *   instead of a fully materialized list.
 * - `batch` — manual selection and `--repo` already know their (small, explicit) final list, so
 *   they resolve to it directly and the caller runs one single-batch import.
 */
export type RepoResolution =
  | { kind: 'streaming'; collection: RepositoryCollection }
  | { kind: 'batch'; repos: ResolvedRepo[]; skipped: SkippedRepo[] };

/**
 * Format a DOP repository's unique identifier the way `provision_projects` expects it:
 * `<slug>|<id>` for GitHub, plain `id` for every other DevOps platform.
 */
export function computeInstallationKey(
  repo: { id: string; slug: string },
  almKey: string | undefined,
): string {
  return almKey === GITHUB_ALM_KEY ? `${repo.slug}|${repo.id}` : repo.id;
}

/** e.g. `my-org/repo - private`. */
function formatRepoLabel(repo: { slug: string; private: boolean }): string {
  const visibility = repo.private ? 'private' : 'public';
  return `${repo.slug} - ${visibility}`;
}

export async function resolveOrg(
  client: SonarQubeClient,
  opts: { org?: string; nonInteractive?: boolean },
): Promise<ResolvedOrg> {
  if (!client.isCloud) {
    throw new CommandFailedError('sonar import is only supported on SonarQube Cloud.', {
      remediationHint: "Run 'sonar auth login' and connect to SonarQube Cloud, then retry.",
    });
  }

  if (opts.org) {
    return resolveOrgByKey(client, opts.org);
  }

  if (opts.nonInteractive) {
    throw new InvalidOptionError(
      '--org is required in non-interactive mode',
      'Pass --org <key> to specify an organization key directly.',
    );
  }

  return promptForOrg(client);
}

async function resolveOrgByKey(client: SonarQubeClient, orgKey: string): Promise<ResolvedOrg> {
  let org;
  try {
    org = await client.fetchOrganizationByKey(orgKey);
  } catch (err) {
    throw new CommandFailedError(
      `Failed to look up organization '${orgKey}': ${err instanceof Error ? err.message : String(err)}`,
      { remediationHint: 'Check your network connection and authentication, then retry.' },
    );
  }
  return {
    key: orgKey,
    almKey: org?.alm?.key,
    onlyPrivateProjectsEnabled: org?.onlyPrivateProjects?.enabled,
  };
}

async function promptForOrg(client: SonarQubeClient): Promise<ResolvedOrg> {
  let orgs: OrganizationCollection;
  try {
    orgs = new OrganizationCollection(
      await withSpinner('Loading organizations...', () => client.fetchAllUserOrganizations()),
    );
  } catch (err) {
    throw new CommandFailedError(
      `Failed to load organizations: ${err instanceof Error ? err.message : String(err)}`,
      { remediationHint: 'Check your network connection and authentication, then retry.' },
    );
  }

  const eligible = orgs.withAdmin().withAlm();

  if (eligible.length === 0) {
    throw new CommandFailedError('No eligible organizations found.', {
      remediationHint:
        'You must be an admin of an organization that has a DevOps platform (GitHub, GitLab, Azure DevOps, or Bitbucket) connected.',
    });
  }

  const LOAD_MORE = Symbol('load-more');

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const options: Array<{ value: ResolvedOrg | typeof LOAD_MORE; label: string }> =
      eligible.visible.map((org) => ({
        value: {
          key: org.key,
          almKey: org.alm?.key,
          onlyPrivateProjectsEnabled: org.onlyPrivateProjects?.enabled,
        },
        label: `${org.name} (${org.key})`,
      }));

    if (eligible.hasMore) {
      options.push({ value: LOAD_MORE, label: 'Load more...' });
    }

    const choice = await selectPrompt('Select an organization', options);

    if (choice === null) {
      throw new CommandFailedError('Organization selection cancelled');
    }

    if (choice === LOAD_MORE) {
      eligible.loadMore();
      continue;
    }

    return choice;
  }
}

/** Returned by `resolveRepos` when the user chooses "← Back" from the onboarding-mode prompt. */
export const BACK = Symbol('back');

export async function resolveRepos(
  client: SonarQubeClient,
  orgKey: string,
  almKey: string | undefined,
  onlyPrivateProjects: OnlyPrivateProjects,
  opts: { org?: string; repo?: string[]; all?: boolean; nonInteractive?: boolean },
): Promise<RepoResolution | typeof BACK> {
  if (opts.all && opts.repo?.length) {
    throw new InvalidOptionError(
      '--all cannot be combined with --repo',
      'Pass either --all to import every eligible repository, or --repo to choose specific ones.',
    );
  }

  if (opts.nonInteractive && !opts.repo?.length && !opts.all) {
    throw new InvalidOptionError(
      '--repo or --all is required in non-interactive mode',
      'Pass --repo <slug> to specify one or more repositories directly, or --all to import every eligible one.',
    );
  }

  const organizationId = await client.getOrganizationLegacyId(orgKey);
  if (!organizationId) {
    throw new CommandFailedError(`Organization '${orgKey}' not found.`, {
      remediationHint: 'Check that the organization key is correct and that you have access to it.',
    });
  }

  if (opts.all) {
    return resolveAllRepos(client, organizationId, onlyPrivateProjects);
  }

  if (opts.repo?.length) {
    const repos = await resolveReposBySlug(
      client,
      organizationId,
      almKey,
      onlyPrivateProjects,
      opts.repo,
    );
    return { kind: 'batch', repos, skipped: [] };
  }

  // "← Back" only makes sense when the org itself was chosen interactively — an org pinned
  // via `--org` has nowhere to go back to, so re-prompting for it would just loop forever.
  return resolveOnboardingMode(client, organizationId, almKey, onlyPrivateProjects, {
    allowBack: !opts.org,
  });
}

/**
 * Load pages of an org's repositories (via `RepositoryCollection.create`, which stops once it
 * finds at least one eligible repo or the org is exhausted) and throw a `CommandFailedError` on
 * a fetch failure or an org with no repositories at all.
 */
async function createRepositoryCollectionOrThrow(
  client: SonarQubeClient,
  organizationId: string,
  onlyPrivateProjects: OnlyPrivateProjects,
): Promise<RepositoryCollection> {
  let collection: RepositoryCollection;
  try {
    collection = await withSpinner('Loading repositories...', () =>
      RepositoryCollection.create(
        (pageIndex, pageSize) =>
          client.fetchDopRepositoriesPage(organizationId, pageIndex, pageSize),
        onlyPrivateProjects,
      ),
    );
  } catch (err) {
    throw new CommandFailedError(
      `Failed to load repositories: ${err instanceof Error ? err.message : String(err)}`,
      { remediationHint: 'Check your network connection and authentication, then retry.' },
    );
  }

  if (collection.total === 0) {
    throw new CommandFailedError('No repositories found for the selected organization.', {
      remediationHint:
        'The organization may have no repositories visible to its connected DevOps platform, or the platform connection may need to be reconfigured.',
    });
  }

  return collection;
}

/**
 * Throws with a specific reason when an org has nothing importable — offering to go back to
 * organization selection first when that's a valid escape hatch (an org pinned via `--org` has
 * nowhere to go back to). `RepositoryCollection.create` only stops early once it finds an
 * eligible repo, so this is only called once every fetched page has been fully scanned.
 */
async function handleNoEligibleRepos(
  collection: RepositoryCollection,
  allowBack: boolean,
): Promise<typeof BACK> {
  const reason = collection.skippedRepos.every((repo) => repo.reason === 'already imported')
    ? 'All repositories for the selected organization have already been imported into SonarQube.'
    : "No repositories match this organization's project visibility settings.";

  if (!allowBack) {
    throw new CommandFailedError(reason);
  }

  warn(reason);
  const goBack = await confirmPrompt('Go back and choose a different organization?', true);
  if (!goBack) {
    throw new CommandFailedError(reason);
  }
  return BACK;
}

/**
 * Ask how the user wants to pick repositories to import: bulk-import everything eligible
 * (mirrors `--all`), choose specific ones interactively, or go back to organization selection.
 *
 * The collection is loaded just far enough to know whether anything is eligible before the
 * prompt is even shown, so an org with nothing importable fails immediately with a specific
 * reason — asking "recommended or manual?" would be pointless (and both branches would hit the
 * same dead end) when there's nothing to import either way. Whichever mode is chosen continues
 * fetching from this same collection rather than starting over from page one.
 */
async function resolveOnboardingMode(
  client: SonarQubeClient,
  organizationId: string,
  almKey: string | undefined,
  onlyPrivateProjects: OnlyPrivateProjects,
  opts: { allowBack: boolean },
): Promise<RepoResolution | typeof BACK> {
  const collection = await createRepositoryCollectionOrThrow(
    client,
    organizationId,
    onlyPrivateProjects,
  );

  if (collection.eligibleRepos.length === 0) {
    return handleNoEligibleRepos(collection, opts.allowBack);
  }

  const RECOMMENDED = Symbol('recommended');
  const MANUAL = Symbol('manual');

  const options: Array<{ value: typeof RECOMMENDED | typeof MANUAL | typeof BACK; label: string }> =
    [
      { value: RECOMMENDED, label: 'Recommended — import all eligible repositories automatically' },
      { value: MANUAL, label: 'Manual — choose repositories yourself' },
    ];
  if (opts.allowBack) {
    options.push({ value: BACK, label: '← Back' });
  }

  // Cancelling the "Manual" picker (below) re-shows this same menu instead of ending the
  // command, so the user can pick a different mode (or go back further) rather than starting
  // `sonar import` over from scratch.
  for (;;) {
    const choice = await selectPrompt('How do you want to import repositories?', options);

    if (choice === null) {
      throw new CommandFailedError('Repository selection cancelled');
    }
    if (choice === BACK) {
      return BACK;
    }
    if (choice === RECOMMENDED) {
      return { kind: 'streaming', collection };
    }

    const repos = await promptForReposFromCollection(collection, almKey);
    if (repos === BACK) {
      continue;
    }
    return { kind: 'batch', repos, skipped: [] };
  }
}

async function resolveReposBySlug(
  client: SonarQubeClient,
  organizationId: string,
  almKey: string | undefined,
  onlyPrivateProjects: OnlyPrivateProjects,
  slugs: string[],
): Promise<ResolvedRepo[]> {
  const matches = await findReposBySlugs(
    (pageIndex, pageSize) => client.fetchDopRepositoriesPage(organizationId, pageIndex, pageSize),
    slugs,
  );

  const notFound = slugs.filter((slug) => !matches.has(slug));
  if (notFound.length > 0) {
    throw new CommandFailedError(
      `Repositor${notFound.length === 1 ? 'y' : 'ies'} not found in the selected organization's DevOps platform: ${notFound.join(', ')}`,
      { remediationHint: 'Check that the repository slug(s) are correct and visible to the org.' },
    );
  }

  const alreadyImported = slugs
    .map((slug) => matches.get(slug))
    .filter((repo): repo is DopRepository => repo !== undefined && isAlreadyImported(repo));
  if (alreadyImported.length === 1) {
    throw new CommandFailedError(
      `Repository '${alreadyImported[0].slug}' has already been imported into SonarQube.`,
    );
  }
  if (alreadyImported.length > 1) {
    throw new CommandFailedError(
      `Repositories have already been imported into SonarQube: ${alreadyImported
        .map((repo) => repo.slug)
        .join(', ')}`,
    );
  }

  const notSelectable = slugs
    .map((slug) => matches.get(slug))
    .filter(
      (repo): repo is DopRepository =>
        repo !== undefined && !isRepoSelectable(repo, onlyPrivateProjects),
    );
  if (notSelectable.length === 1) {
    const repo = notSelectable[0];
    throw new CommandFailedError(
      `Repository '${repo.slug}' is ${repo.private ? 'private' : 'public'}, which isn't allowed by this organization's project visibility settings.`,
    );
  }
  if (notSelectable.length > 1) {
    throw new CommandFailedError(
      `Repositories are not allowed by this organization's project visibility settings: ${notSelectable
        .map((repo) => `${repo.slug} (${repo.private ? 'private' : 'public'})`)
        .join(', ')}`,
    );
  }

  return slugs.map((slug) => {
    const repo = matches.get(slug);
    if (!repo) {
      throw new CommandFailedError(`Repository '${slug}' not found.`);
    }
    return { slug: repo.slug, installationKey: computeInstallationKey(repo, almKey) };
  });
}

/**
 * Whether a repo's visibility is selectable under the org's `onlyPrivateProjects` setting.
 * Unavailable means public-only, available+enabled means private-only, available+disabled
 * allows both. Duplicated in spirit from `RepositoryCollection`'s internal categorization —
 * `--repo` resolution needs this on a handful of explicitly-named repos, not on every page.
 */
function isRepoSelectable(
  repo: { private: boolean },
  onlyPrivateProjects: OnlyPrivateProjects,
): boolean {
  if (!onlyPrivateProjects.available) return !repo.private;
  if (onlyPrivateProjects.enabled) return repo.private;
  return true;
}

/**
 * Resolve every eligible repository in the org for `--all` as a live streaming job: the caller
 * (`runBulkImportJob`) imports each page's eligible repos as soon as it's fetched instead of
 * waiting for the whole org to be scanned first.
 */
async function resolveAllRepos(
  client: SonarQubeClient,
  organizationId: string,
  onlyPrivateProjects: OnlyPrivateProjects,
): Promise<RepoResolution> {
  const collection = await createRepositoryCollectionOrThrow(
    client,
    organizationId,
    onlyPrivateProjects,
  );

  if (collection.eligibleRepos.length === 0) {
    throw new CommandFailedError(
      `No repositories are eligible for import (${collection.skippedRepos.length} skipped: already imported, or excluded by project visibility settings).`,
    );
  }

  return { kind: 'streaming', collection };
}

/**
 * Fetch an org's repositories page by page, stopping as soon as every requested slug has been
 * matched instead of always scanning the whole org.
 */
async function findReposBySlugs(
  fetchPage: FetchPage,
  slugs: string[],
): Promise<Map<string, DopRepository>> {
  const remaining = new Set(slugs);
  const found = new Map<string, DopRepository>();

  for await (const { repositories } of iterateRepoPages(fetchPage)) {
    for (const repo of repositories) {
      if (remaining.has(repo.slug)) {
        found.set(repo.slug, repo);
        remaining.delete(repo.slug);
      }
    }
    if (remaining.size === 0) break;
  }

  return found;
}

/** Max number of repos selectable at once in the "Manual" picker. */
const MANUAL_SELECT_MAX_REPOS = 25;

/**
 * Interactive multi-select over a live, lazily-paginated `RepositoryCollection`: "Load more"
 * fetches and categorizes the next server page on demand. There's no "select all" here — the
 * full set is never known up front, so there is nothing safe to bulk-select.
 */
async function promptForReposFromCollection(
  collection: RepositoryCollection,
  almKey: string | undefined,
): Promise<ResolvedRepo[] | typeof BACK> {
  // `multiSelectPrompt` tracks selections by `===` identity, so the same `DopRepository`
  // must always map to the same `ResolvedRepo` object across a "Load more" reload, or
  // previously toggled selections would be silently dropped.
  const resolvedByRepo = new WeakMap<DopRepository, ResolvedRepo>();
  const toOption = (repo: DopRepository): MultiSelectOption<ResolvedRepo> => {
    let resolved = resolvedByRepo.get(repo);
    if (!resolved) {
      resolved = { slug: repo.slug, installationKey: computeInstallationKey(repo, almKey) };
      resolvedByRepo.set(repo, resolved);
    }
    return { value: resolved, label: formatRepoLabel(repo) };
  };

  const result = await multiSelectPrompt(
    'Select repositories to import',
    collection.eligibleRepos.map(toOption),
    {
      hasMore: () => collection.hasMore,
      onLoadMore: async () => {
        await collection.loadMore();
        return collection.eligibleRepos.map(toOption);
      },
      maxSelected: MANUAL_SELECT_MAX_REPOS,
      // Only what's been paginated into view so far — the true total isn't known until every
      // page has been fetched, which is exactly why there's no "select all" for this picker.
      total: () => collection.eligibleRepos.length,
    },
  );

  // Cancelling (q / Ctrl+C) goes back to the Recommended/Manual/← Back menu that led here,
  // rather than ending the whole command — the caller (`resolveOnboardingMode`) re-shows it.
  if (result === null) {
    return BACK;
  }
  if (result.length === 0) {
    throw new CommandFailedError('No repositories selected.');
  }

  return result;
}
