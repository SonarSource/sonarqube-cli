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
