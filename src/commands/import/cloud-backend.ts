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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { Console } from '@/core/ui/console.ts';

import type { ImportApiClient } from './import-api.ts';
import type { ImportBackend, ImportPlan } from './import-backend.ts';
import type { OnlyPrivateProjects } from './repository-collection';
import { computeInstallationKey, resolveAlmKey, resolveOrg, resolveRepos } from './resolve-options';
import type { ImportOptions } from './types';

/** SonarQube Cloud: the org is the one tied to the active connection. */
export class CloudBackend implements ImportBackend {
  constructor(
    private readonly client: ImportApiClient,
    private readonly orgKey: string | undefined,
    private readonly serverUrl: string,
  ) {}

  async plan(options: ImportOptions, console: Console): Promise<ImportPlan> {
    const {
      key: resolvedOrgKey,
      almKey: resolvedAlmKey,
      onlyPrivateProjectsEnabled,
    } = await resolveOrg(this.client, this.orgKey);

    console.info(`Organization: ${resolvedOrgKey}`);

    const [almKey, privateProjectsAvailable] = await Promise.all([
      resolveAlmKey(this.client, resolvedOrgKey, resolvedAlmKey),
      this.client.organizations.hasPrivateProjectsEntitlement(resolvedOrgKey).match(
        (value) => value,
        (error) => {
          throw new CommandFailedError(
            `Failed to check private-projects entitlement for organization '${resolvedOrgKey}': ${error.message}`,
            { remediationHint: 'Check your network connection and authentication, then retry.' },
          );
        },
      ),
    ]);

    const onlyPrivateProjects: OnlyPrivateProjects = {
      enabled: onlyPrivateProjectsEnabled ?? false,
      available: privateProjectsAvailable,
    };

    const selection = await resolveRepos(this.client, resolvedOrgKey, almKey, onlyPrivateProjects, {
      ...options,
      console,
    });

    const client = this.client;
    return {
      selection,
      outroLink: {
        label: 'Dashboard',
        url: `${this.serverUrl.replace(/\/$/, '')}/organizations/${resolvedOrgKey}/onboarding-dashboard`,
      },
      toResolvedRepo: (repo) => ({
        slug: repo.slug,
        installationKey: computeInstallationKey(repo, almKey),
      }),
      importRepo: async (repo) => {
        const result = await client.provisionProject(resolvedOrgKey, repo.installationKey);
        if (result.projects.length === 0) {
          throw new Error(
            'provision_projects returned no project: the repository may already be bound, or ' +
              'the installation key was rejected by the server.',
          );
        }
        await client.requestAutoscanEligibility(result.projects[0].projectKey);
      },
    };
  }
}
