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

import { BadRequestError } from '@/core/server/errors.ts';

import type { DopRepository, ImportApiClient } from './import-api.ts';
import {
  type ImportPlan,
  type ImportRepoOutcome,
  mapWithLimit,
  type MonorepoProgressReporter,
  projectOverviewUrl,
} from './import-backend.ts';
import type { MonorepoProject } from './monorepo-projects.ts';
import {
  accountsForEveryProject,
  type MonorepoProvisionErrors,
  parseMonorepoProvisionErrors,
} from './monorepo-provision-errors.ts';
import { computeInstallationKey, type RepoResolution, type ResolvedRepo } from './resolve-options';

const NOT_CREATED = 'SonarQube Cloud did not create this project.';

/** A SonarQube Cloud import run: the organization is resolved and its repositories are selected. */
export class CloudImportPlan implements ImportPlan {
  readonly outroLink: { label: string; url: string };

  constructor(
    private readonly client: ImportApiClient,
    private readonly organization: string,
    private readonly almKey: string | undefined,
    private readonly serverUrl: string,
    readonly selection: RepoResolution,
  ) {
    this.outroLink = {
      label: 'Dashboard',
      url: `${serverUrl.replace(/\/$/, '')}/organizations/${organization}/onboarding-dashboard`,
    };
  }

  projectUrl(projectKey: string): string {
    return projectOverviewUrl(this.serverUrl, projectKey);
  }

  toResolvedRepo(repo: DopRepository): ResolvedRepo {
    return {
      slug: repo.slug,
      installationKey: computeInstallationKey(repo, this.almKey),
      boundProjectIds: repo.boundProjectIds,
    };
  }

  async importRepo(repo: ResolvedRepo): Promise<ImportRepoOutcome> {
    return {
      projectKey: await this.client.importRepository(this.organization, repo.installationKey),
    };
  }

  async listBoundProjectKeys(repo: ResolvedRepo): Promise<{ keys: string[]; elsewhere: number }> {
    const ids = repo.boundProjectIds ?? [];
    const keys =
      ids.length === 0
        ? []
        : await this.client.projects.findProjectKeysByIds(this.organization, ids).orThrow();
    return { keys, elsewhere: Math.max(ids.length - keys.length, 0) };
  }

  async findExistingProjectKeys(_repo: ResolvedRepo, projectKeys: string[]): Promise<string[]> {
    const found = await mapWithLimit(projectKeys, async (key) =>
      (await this.projectExistsOrThrow(key)) ? key : null,
    );
    return found.filter((key): key is string => key !== null);
  }

  /**
   * One batch call, then a verdict per project. A project is `done` only when the server created it
   * (listed in a 200) or is known to exist after a partly refused batch; it is never assumed.
   */
  async importMonorepo(
    repo: ResolvedRepo,
    projects: MonorepoProject[],
    report: MonorepoProgressReporter,
  ): Promise<void> {
    const keys = projects.map(({ projectKey }) => projectKey);
    for (const projectKey of keys) report(projectKey, 'running');

    const failures = await this.provisionFailures(repo.installationKey, projects);
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
  private async provisionFailures(
    installationKey: string,
    projects: MonorepoProject[],
  ): Promise<Map<string, string>> {
    const keys = projects.map(({ projectKey }) => projectKey);
    try {
      const result = await this.client.provisionMonorepoProjects(
        this.organization,
        installationKey,
        projects,
      );
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
      return this.settleRefusals(keys, parsed);
    }
  }

  /**
   * The server committed every project it did not refuse, but a 400 lists only the refused ones.
   * When those add up, the rest exist; otherwise each unaccounted project is looked up before it
   * is called done.
   */
  private async settleRefusals(
    keys: string[],
    parsed: MonorepoProvisionErrors,
  ): Promise<Map<string, string>> {
    const failures = new Map(parsed.refusals);
    if (accountsForEveryProject(parsed, keys)) {
      return failures;
    }
    const reason = parsed.untagged.join(' ') || NOT_CREATED;
    const unaccounted = keys.filter((key) => !failures.has(key));
    const lookups = await mapWithLimit(unaccounted, async (key) => ({
      key,
      found: await this.projectExists(key),
    }));
    for (const { key, found } of lookups) {
      if (!found) failures.set(key, reason);
    }
    return failures;
  }

  /** Lookup failures propagate, so an outage is never mistaken for a project that does not exist. */
  private async projectExistsOrThrow(projectKey: string): Promise<boolean> {
    const project = await this.client.projects.findProject(projectKey, this.organization).orThrow();
    return project !== null;
  }

  /** Lenient lookup: a failure reads as "not found", which only ever marks a project as failed. */
  private projectExists(projectKey: string): Promise<boolean> {
    return this.client.projects.findProject(projectKey, this.organization).match(
      (project) => project !== null,
      () => false,
    );
  }
}

function failuresFor(keys: string[], reason: string): Map<string, string> {
  return new Map(keys.map((key) => [key, reason]));
}
