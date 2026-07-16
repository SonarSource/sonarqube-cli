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
import { isAlreadyImported, RepositoryCollection } from './repository-collection';

/** ALM key used by GitHub-bound organizations, per `Organization.alm.key`. */
const GITHUB_ALM_KEY = 'github';

export interface OnlyPrivateProjects {
  enabled: boolean;
  available: boolean;
}

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

export interface SkippedRepo {
  slug: string;
  reason: string;
}

export interface ResolvedRepos {
  repos: ResolvedRepo[];
  /** Repos deliberately excluded by `--all`'s eligibility filtering, with a reason each. */
  skipped: SkippedRepo[];
}

/**
 * Format a DOP repository's unique identifier the way `provision_projects` expects it:
 * `<slug>|<id>` for GitHub, plain `id` for every other DevOps platform.
 */
function computeInstallationKey(
  repo: { id: string; slug: string },
  almKey: string | undefined,
): string {
  return almKey === GITHUB_ALM_KEY ? `${repo.slug}|${repo.id}` : repo.id;
}

/**
 * Whether a repo's visibility is selectable under the org's `onlyPrivateProjects` setting.
 * Unavailable means public-only, available+enabled means private-only, available+disabled
 * allows both.
 */
function isRepoSelectable(
  repo: { private: boolean },
  onlyPrivateProjects: OnlyPrivateProjects,
): boolean {
  if (!onlyPrivateProjects.available) return !repo.private;
  if (onlyPrivateProjects.enabled) return repo.private;
  return true;
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
): Promise<ResolvedRepos | typeof BACK> {
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
    return resolveAllRepos(client, organizationId, almKey, onlyPrivateProjects);
  }

  if (opts.repo?.length) {
    const repos = await resolveReposBySlug(
      client,
      organizationId,
      almKey,
      onlyPrivateProjects,
      opts.repo,
    );
    return { repos, skipped: [] };
  }

  // "← Back" only makes sense when the org itself was chosen interactively — an org pinned
  // via `--org` has nowhere to go back to, so re-prompting for it would just loop forever.
  return resolveOnboardingMode(client, organizationId, almKey, onlyPrivateProjects, {
    allowBack: !opts.org,
  });
}

/**
 * Ask how the user wants to pick repositories to import: bulk-import everything eligible
 * (mirrors `--all`), choose specific ones interactively, or go back to organization selection.
 *
 * Eligibility is computed once up front (before the prompt is even shown) so an org with
 * nothing importable fails immediately with a specific reason, the same way it always has —
 * asking "recommended or manual?" would be pointless (and both branches would hit the same
 * dead end) when there's nothing to import either way.
 */
async function resolveOnboardingMode(
  client: SonarQubeClient,
  organizationId: string,
  almKey: string | undefined,
  onlyPrivateProjects: OnlyPrivateProjects,
  opts: { allowBack: boolean },
): Promise<ResolvedRepos | typeof BACK> {
  const allRepos = await fetchAllReposOrThrow(client, organizationId);
  const { eligible, skipped } = categorizeRepos(allRepos, onlyPrivateProjects);

  if (eligible.length === 0) {
    const reason = allRepos.every((repo) => isAlreadyImported(repo))
      ? 'All repositories for the selected organization have already been imported into SonarQube.'
      : "No repositories match this organization's project visibility settings.";

    if (!opts.allowBack) {
      throw new CommandFailedError(reason);
    }

    warn(reason);
    const goBack = await confirmPrompt('Go back and choose a different organization?', true);
    if (!goBack) {
      throw new CommandFailedError(reason);
    }
    return BACK;
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

  const choice = await selectPrompt('How do you want to import repositories?', options);

  if (choice === null) {
    throw new CommandFailedError('Repository selection cancelled');
  }
  if (choice === BACK) {
    return BACK;
  }
  if (choice === RECOMMENDED) {
    return {
      repos: eligible.map((repo) => ({
        slug: repo.slug,
        installationKey: computeInstallationKey(repo, almKey),
      })),
      skipped,
    };
  }

  const repos = await promptForReposFromCollection(new RepositoryCollection(eligible), almKey);
  return { repos, skipped: [] };
}

async function resolveReposBySlug(
  client: SonarQubeClient,
  organizationId: string,
  almKey: string | undefined,
  onlyPrivateProjects: OnlyPrivateProjects,
  slugs: string[],
): Promise<ResolvedRepo[]> {
  const matches = await findReposBySlugs(client, organizationId, slugs);

  const notFound = slugs.filter((slug) => !matches.has(slug));
  if (notFound.length > 0) {
    throw new CommandFailedError(
      `Repositor${notFound.length === 1 ? 'y' : 'ies'} not found in the selected organization's DevOps platform: ${notFound.join(', ')}`,
      { remediationHint: 'Check that the repository slug(s) are correct and visible to the org.' },
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
 * Fetch every repository for an org (across all server pages), throwing a `CommandFailedError`
 * on a fetch failure or an org with no repositories at all.
 */
async function fetchAllReposOrThrow(
  client: SonarQubeClient,
  organizationId: string,
): Promise<DopRepository[]> {
  let allRepos: DopRepository[];
  try {
    allRepos = await withSpinner('Loading repositories...', () =>
      RepositoryCollection.fetchAll((pageIndex, pageSize) =>
        client.fetchDopRepositoriesPage(organizationId, pageIndex, pageSize),
      ),
    );
  } catch (err) {
    throw new CommandFailedError(
      `Failed to load repositories: ${err instanceof Error ? err.message : String(err)}`,
      { remediationHint: 'Check your network connection and authentication, then retry.' },
    );
  }

  if (allRepos.length === 0) {
    throw new CommandFailedError('No repositories found for the selected organization.', {
      remediationHint:
        'The organization may have no repositories visible to its connected DevOps platform, or the platform connection may need to be reconfigured.',
    });
  }

  return allRepos;
}

/**
 * Split repos into those eligible for import — not already imported (see `isAlreadyImported`)
 * and allowed by the org's project visibility settings — and those skipped, with a reason each.
 */
function categorizeRepos(
  allRepos: DopRepository[],
  onlyPrivateProjects: OnlyPrivateProjects,
): { eligible: DopRepository[]; skipped: SkippedRepo[] } {
  const eligible: DopRepository[] = [];
  const skipped: SkippedRepo[] = [];

  for (const repo of allRepos) {
    if (isAlreadyImported(repo)) {
      skipped.push({ slug: repo.slug, reason: 'already imported' });
      continue;
    }
    if (!isRepoSelectable(repo, onlyPrivateProjects)) {
      skipped.push({
        slug: repo.slug,
        reason: `${repo.private ? 'private' : 'public'} repos aren't allowed by this organization's project visibility settings`,
      });
      continue;
    }
    eligible.push(repo);
  }

  return { eligible, skipped };
}

/**
 * Resolve every eligible repository in the org for `--all`. Ineligible repos are reported back
 * with a reason instead of causing the whole command to fail, since a mixed batch (some
 * eligible, some not) is the normal case for a whole-org import.
 */
async function resolveAllRepos(
  client: SonarQubeClient,
  organizationId: string,
  almKey: string | undefined,
  onlyPrivateProjects: OnlyPrivateProjects,
): Promise<ResolvedRepos> {
  const allRepos = await fetchAllReposOrThrow(client, organizationId);
  const { eligible, skipped } = categorizeRepos(allRepos, onlyPrivateProjects);

  if (eligible.length === 0) {
    throw new CommandFailedError(
      `No repositories are eligible for import (${skipped.length} skipped: already imported, or excluded by project visibility settings).`,
    );
  }

  return {
    repos: eligible.map((repo) => ({
      slug: repo.slug,
      installationKey: computeInstallationKey(repo, almKey),
    })),
    skipped,
  };
}

/**
 * Fetch every repository for an org (across all server pages) and resolve a set of slugs
 * against it in one pass — avoids N full scans for N `--repo` flags.
 */
async function findReposBySlugs(
  client: SonarQubeClient,
  organizationId: string,
  slugs: string[],
): Promise<Map<string, DopRepository>> {
  const remaining = new Set(slugs);
  const found = new Map<string, DopRepository>();

  const allRepos = await RepositoryCollection.fetchAll((pageIndex, pageSize) =>
    client.fetchDopRepositoriesPage(organizationId, pageIndex, pageSize),
  );

  for (const repo of allRepos) {
    if (remaining.has(repo.slug)) found.set(repo.slug, repo);
  }

  return found;
}

/**
 * Interactive multi-select over an already-fetched, already-filtered collection of eligible
 * repos (see `resolveOnboardingMode`, which computes eligibility once up front for both the
 * "Recommended" and "Manual" branches).
 */
async function promptForReposFromCollection(
  repos: RepositoryCollection,
  almKey: string | undefined,
): Promise<ResolvedRepo[]> {
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
    repos.visible.map(toOption),
    {
      hasMore: () => repos.hasMore,
      onLoadMore: () => {
        repos.loadMore();
        return repos.visible.map(toOption);
      },
      // 'a' bulk-selects every eligible repo, not just the currently-paged-in ones — reveal
      // every remaining page first so the rendered list and the selection stay consistent.
      selectAll: () => {
        while (repos.hasMore) repos.loadMore();
        return repos.visible.map(toOption);
      },
      // No business reason to cap a repo import batch (unlike `sonar remediate`'s
      // MULTISELECT_MAX_SELECTED default, which mirrors a remediation-agent capacity limit).
      maxSelected: Number.POSITIVE_INFINITY,
      // The true eligible count, not just what's paginated into view yet.
      total: () => repos.length,
    },
  );

  if (result === null) {
    throw new CommandFailedError('Repository selection cancelled');
  }
  if (result.length === 0) {
    throw new CommandFailedError('No repositories selected.');
  }

  return result;
}
