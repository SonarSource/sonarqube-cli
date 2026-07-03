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

import { type SonarQubeClient } from '../../../../sonarqube/client';
import { selectPrompt, withSpinner } from '../../../../ui';
import { CommandFailedError, InvalidOptionError } from '../../_common/error';
import { OrganizationCollection } from './organization-collection';
import { RepositoryCollection } from './repository-collection';

export async function resolveOrg(
  client: SonarQubeClient,
  opts: { org?: string; nonInteractive?: boolean },
): Promise<string> {
  if (!client.isCloud) {
    throw new CommandFailedError('sonar import is only supported on SonarQube Cloud.', {
      remediationHint: "Run 'sonar auth login' and connect to SonarQube Cloud, then retry.",
    });
  }

  if (opts.org) return opts.org;

  if (opts.nonInteractive) {
    throw new InvalidOptionError(
      '--org is required in non-interactive mode',
      'Pass --org <key> to specify an organization key directly.',
    );
  }

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
    const options: Array<{ value: string | typeof LOAD_MORE; label: string }> =
      eligible.visible.map((org) => ({
        value: org.key,
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
  opts: { repo?: string; nonInteractive?: boolean },
): Promise<string> {
  if (opts.repo) return opts.repo;

  if (opts.nonInteractive) {
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
    const options: Array<{ value: string | typeof LOAD_MORE; label: string }> = repos.visible.map(
      (repo) => ({
        value: repo.slug,
        label: repo.importedInCurrentOrg ? `${repo.slug} (already imported)` : repo.slug,
      }),
    );

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
