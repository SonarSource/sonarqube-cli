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

import type { ResolvedAuth } from '../../../lib/auth-resolver';
import { SonarQubeClient } from '../../../sonarqube/client';
import { info, intro, outro, withSpinner } from '../../../ui';
import { CommandFailedError } from '../_common/error';
import { type OnlyPrivateProjects, resolveOrg, resolveRepo } from './_common/resolve-options';
import type { ImportOptions } from './_common/types';

export { type ImportOptions } from './_common/types';

export async function importHandler(options: ImportOptions, auth: ResolvedAuth): Promise<void> {
  const client = new SonarQubeClient(auth.serverUrl, auth.token);

  intro('Import repository', 'SonarQube');

  const {
    key: orgKey,
    almKey: resolvedAlmKey,
    onlyPrivateProjectsEnabled,
  } = await resolveOrg(client, options);

  info(`Organization: ${orgKey}`);

  const [almKey, privateProjectsAvailable] = await Promise.all([
    resolvedAlmKey ?? client.getOrganizationAlmKey(orgKey),
    client.hasPrivateProjectsEntitlement(orgKey),
  ]);
  const onlyPrivateProjects: OnlyPrivateProjects = {
    enabled: onlyPrivateProjectsEnabled ?? false,
    available: privateProjectsAvailable,
  };

  const { slug: repoSlug, installationKey } = await resolveRepo(
    client,
    orgKey,
    almKey,
    onlyPrivateProjects,
    options,
  );

  info(`Repository: ${repoSlug}`);
  let result;
  try {
    result = await withSpinner('Creating SonarQube project...', () =>
      client.provisionProject(orgKey, installationKey),
    );
  } catch (err) {
    throw new CommandFailedError(
      `Failed to create project: ${err instanceof Error ? err.message : String(err)}`,
      {
        remediationHint:
          'Check that the repository is not already imported and that you have permission to create projects in this organization.',
      },
    );
  }

  if (result.projects.length === 0) {
    throw new CommandFailedError(
      'provision_projects returned no project — the repository may already be bound, or the ' +
        'installation key was rejected by the server.',
    );
  }
  const project = result.projects[0];

  outro(`Project created: ${project.projectKey}`, 'success');
}
