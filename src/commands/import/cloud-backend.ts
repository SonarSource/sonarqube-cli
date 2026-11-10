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
import { BadRequestError } from '@/core/server/errors.ts';
import type { Console } from '@/core/ui/console.ts';

import type { ImportApiClient } from './import-api.ts';
import type { ImportBackend, ImportPlan, MonorepoProgressReporter } from './import-backend.ts';
import type { MonorepoProject } from './monorepo-projects.ts';
import {
  accountsForEveryProject,
  type MonorepoProvisionErrors,
  parseMonorepoProvisionErrors,
} from './monorepo-provision-errors.ts';
import type { OnlyPrivateProjects } from './repository-collection';
import {
  computeInstallationKey,
  resolveAlmKey,
  type ResolvedOrg,
  resolveOrg,
  resolveRepos,
} from './resolve-options';
import type { ImportOptions } from './types';

/** SonarQube Cloud: the org is the one tied to the active connection. */
export class CloudBackend implements ImportBackend {
  constructor(
    private readonly client: ImportApiClient,
    private readonly orgKey: string | undefined,
    private readonly serverUrl: string,
    private readonly resolvedOrg?: ResolvedOrg,
  ) {}

  async plan(options: ImportOptions, console: Console): Promise<ImportPlan> {
    const {
      key: resolvedOrgKey,
      almKey: resolvedAlmKey,
      onlyPrivateProjectsEnabled,
    } = this.resolvedOrg ?? (await resolveOrg(this.client, this.orgKey));

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
      importRepo: async (repo) => ({
        projectKey: await client.importRepository(resolvedOrgKey, repo.installationKey),
      }),
      importMonorepo: (repo, projects, report) =>
        importMonorepoProjects(client, resolvedOrgKey, repo.installationKey, projects, report),
    };
  }
}

const NOT_CREATED = 'SonarQube Cloud did not create this project.';

/**
 * One batch call, then a verdict per project. A project is `done` only when the server created it
 * (listed in a 200) or is known to exist after a partly refused batch; it is never assumed.
 */
export async function importMonorepoProjects(
  client: ImportApiClient,
  organization: string,
  installationKey: string,
  projects: MonorepoProject[],
  report: MonorepoProgressReporter,
): Promise<void> {
  const keys = projects.map(({ projectKey }) => projectKey);
  for (const projectKey of keys) report(projectKey, 'running');

  const failures = await provisionFailures(client, organization, installationKey, projects);
  for (const projectKey of keys) {
    const reason = failures.get(projectKey);
    if (reason === undefined) {
      report(projectKey, 'done');
    } else {
      report(projectKey, 'failed', reason);
    }
  }
}

/** The reason each project failed; a project absent from the map exists. */
async function provisionFailures(
  client: ImportApiClient,
  organization: string,
  installationKey: string,
  projects: MonorepoProject[],
): Promise<Map<string, string>> {
  const keys = projects.map(({ projectKey }) => projectKey);
  try {
    const result = await client.provisionMonorepoProjects(organization, installationKey, projects);
    const created = new Set((result.projects ?? []).map((project) => project.projectKey));
    return failuresFor(
      keys.filter((key) => !created.has(key)),
      NOT_CREATED,
    );
  } catch (error) {
    const parsed =
      error instanceof BadRequestError ? parseMonorepoProvisionErrors(keys, error.errors) : null;
    if (parsed === null) {
      return failuresFor(keys, error instanceof Error ? error.message : String(error));
    }
    return settleRefusals(client, organization, keys, parsed);
  }
}

/**
 * The server committed every project it did not refuse, but a 400 lists only the refused ones. When
 * those add up, the rest exist; otherwise each unaccounted project is looked up before it is called done.
 */
async function settleRefusals(
  client: ImportApiClient,
  organization: string,
  keys: string[],
  parsed: MonorepoProvisionErrors,
): Promise<Map<string, string>> {
  const failures = new Map(parsed.refusals);
  if (accountsForEveryProject(parsed, keys)) {
    return failures;
  }
  const reason = parsed.untagged.join(' ') || NOT_CREATED;
  const unaccounted = keys.filter((key) => !failures.has(key));
  const lookups = await Promise.all(
    unaccounted.map(async (key) => ({
      key,
      found: await projectExists(client, organization, key),
    })),
  );
  for (const { key, found } of lookups) {
    if (!found) failures.set(key, reason);
  }
  return failures;
}

function projectExists(
  client: ImportApiClient,
  organization: string,
  projectKey: string,
): Promise<boolean> {
  return client.projects.findProject(projectKey, organization).match(
    (project) => project !== null,
    () => false,
  );
}

function failuresFor(keys: string[], reason: string): Map<string, string> {
  return new Map(keys.map((key) => [key, reason]));
}
