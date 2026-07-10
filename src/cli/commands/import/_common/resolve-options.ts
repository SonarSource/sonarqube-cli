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
import { selectPrompt, withSpinner } from '../../../../ui';
import { CommandFailedError, InvalidOptionError } from '../../_common/error';
import { OrganizationCollection } from './organization-collection';
import { RepositoryCollection } from './repository-collection';

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

export async function resolveRepo(
  client: SonarQubeClient,
  orgKey: string,
  almKey: string | undefined,
  onlyPrivateProjects: OnlyPrivateProjects,
  opts: { repo?: string; nonInteractive?: boolean },
): Promise<ResolvedRepo> {
  if (opts.nonInteractive && !opts.repo) {
    throw new InvalidOptionError(
      '--repo is required in non-interactive mode',
      'Pass --repo <slug> to specify a repository directly.',
    );
  }

  const organizationId = await client.getOrganizationLegacyId(orgKey);
  if (!organizationId) {
    throw new CommandFailedError(`Organization '${orgKey}' not found.`, {
      remediationHint: 'Check that the organization key is correct and that you have access to it.',
    });
  }

  if (opts.repo) {
    return resolveRepoBySlug(client, organizationId, almKey, onlyPrivateProjects, opts.repo);
  }

  return promptForRepo(client, organizationId, almKey, onlyPrivateProjects);
}

async function resolveRepoBySlug(
  client: SonarQubeClient,
  organizationId: string,
  almKey: string | undefined,
  onlyPrivateProjects: OnlyPrivateProjects,
  slug: string,
): Promise<ResolvedRepo> {
  const repo = await findRepoBySlug(client, organizationId, slug);
  if (!repo) {
    throw new CommandFailedError(
      `Repository '${slug}' not found in the selected organization's DevOps platform.`,
      { remediationHint: 'Check that the repository slug is correct and visible to the org.' },
    );
  }
  if (!isRepoSelectable(repo, onlyPrivateProjects)) {
    throw new CommandFailedError(
      `Repository '${slug}' is ${repo.private ? 'private' : 'public'}, which isn't allowed by this organization's project visibility settings.`,
    );
  }
  return { slug: repo.slug, installationKey: computeInstallationKey(repo, almKey) };
}

async function promptForRepo(
  client: SonarQubeClient,
  organizationId: string,
  almKey: string | undefined,
  onlyPrivateProjects: OnlyPrivateProjects,
): Promise<ResolvedRepo> {
  let repos: RepositoryCollection;
  try {
    repos = await withSpinner('Loading repositories...', () =>
      RepositoryCollection.create((pageIndex, pageSize) =>
        client.fetchDopRepositoriesPage(organizationId, pageIndex, pageSize),
      ),
    );
  } catch (err) {
    throw new CommandFailedError(
      `Failed to load repositories: ${err instanceof Error ? err.message : String(err)}`,
      { remediationHint: 'Check your network connection and authentication, then retry.' },
    );
  }

  if (repos.length === 0) {
    throw new CommandFailedError('No repositories found for the selected organization.', {
      remediationHint:
        'The organization may have no repositories visible to its connected DevOps platform, or the platform connection may need to be reconfigured.',
    });
  }

  const LOAD_MORE = Symbol('load-more');

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const selectable = await loadNextSelectablePage(repos, onlyPrivateProjects);

    const options: Array<{
      value: ResolvedRepo | typeof LOAD_MORE;
      label: string;
    }> = selectable.map((repo) => ({
      value: { slug: repo.slug, installationKey: computeInstallationKey(repo, almKey) },
      label: formatRepoLabel(repo),
    }));

    if (repos.hasMore) {
      options.push({ value: LOAD_MORE, label: 'Load more...' });
    }

    const choice = await selectPrompt('Select a repository', options);

    if (choice === null) {
      throw new CommandFailedError('Repository selection cancelled');
    }

    if (choice === LOAD_MORE) {
      await repos.loadMore();
      continue;
    }

    return choice;
  }
}

/**
 * Advances `repos` past pages with nothing selectable (already imported, or excluded by
 * the org's visibility settings), returning the selectable repos on the first page that has
 * any. Throws once the collection is exhausted without finding one.
 */
async function loadNextSelectablePage(
  repos: RepositoryCollection,
  onlyPrivateProjects: OnlyPrivateProjects,
): Promise<DopRepository[]> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const importable = repos.visible.filter((repo) => !repo.importedInCurrentOrg);
    // `selectPrompt` has no concept of disabled options, so repos that don't match the
    // org's visibility settings must be filtered out entirely rather than merely flagged.
    const selectable = importable.filter((repo) => isRepoSelectable(repo, onlyPrivateProjects));

    if (selectable.length > 0) return selectable;

    if (!repos.hasMore) {
      throw new CommandFailedError(
        importable.length === 0
          ? 'All repositories for the selected organization have already been imported into SonarQube.'
          : "No repositories match this organization's project visibility settings.",
      );
    }

    await repos.loadMore();
  }
}

/**
 * Search all server pages of an organization's DOP repositories for an exact `slug` match.
 * Used for the `--repo` fast path, which still needs the repo's `id` to compute the
 * `installationKey` for provisioning even though it skips the interactive select prompt.
 */
async function findRepoBySlug(
  client: SonarQubeClient,
  organizationId: string,
  slug: string,
): Promise<{ id: string; slug: string; private: boolean } | undefined> {
  const repos = await RepositoryCollection.create((pageIndex, pageSize) =>
    client.fetchDopRepositoriesPage(organizationId, pageIndex, pageSize),
  );

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const match = repos.visible.find((repo) => repo.slug === slug);
    if (match) return match;
    if (!repos.hasMore) return undefined;
    await repos.loadMore();
  }
}
