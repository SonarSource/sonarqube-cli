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

import { inspect } from 'node:util';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { runWithConcurrencyLimit } from '@/core/concurrency/concurrency-pool.ts';
import { BadRequestError, UnexpectedApiError } from '@/core/server/errors.ts';

import type { DopRepository } from '../import-api.ts';
import {
  type ImportPlan,
  type ImportRepoOutcome,
  mapWithLimit,
  type MonorepoProgressReporter,
  projectOverviewUrl,
} from '../import-backend.ts';
import type { MonorepoProject } from '../monorepo-projects.ts';
import type { RepoResolution, ResolvedRepo } from '../resolve-options';
import { reconnectUrl } from './connect-url.ts';
import { explainImportFailure } from './import-failure.ts';
import { assertProjectKeyUsable, listBoundProjectKeys } from './key-guard.ts';
import { deriveProjectKey } from './project-key.ts';
import {
  DOP_PLATFORM_LABELS,
  type DopSetting,
  type ServerImportApiClient,
} from './server-import-api.ts';
import type { ServerRepository } from './server-repository.ts';

const CREATION_CONFLICT_STATUS = 409;

const ALREADY_BOUND = 'project already exists with matching binding';

/** A SonarQube Server import run: a DevOps platform setting is chosen and its repositories listed. */
export class ServerImportPlan implements ImportPlan {
  readonly outroLink: { label: string; url: string };
  /** The project key each repository got in this run, to catch two repositories deriving the same one. */
  private readonly claimedKeys = new Map<string, string>();

  constructor(
    private readonly api: ServerImportApiClient,
    private readonly serverUrl: string,
    private readonly setting: DopSetting,
    /** Every repository the run has listed, by id; filled while `selection` pages in. */
    private readonly repositories: ReadonlyMap<string, ServerRepository>,
    readonly selection: RepoResolution,
  ) {
    this.outroLink = {
      label: 'Dashboard',
      url: `${serverUrl.replace(/\/$/, '')}/admin/project-coverage`,
    };
  }

  projectUrl(projectKey: string): string {
    return projectOverviewUrl(this.serverUrl, projectKey);
  }

  toResolvedRepo(repo: DopRepository): ResolvedRepo {
    return { slug: repo.slug, installationKey: repo.id };
  }

  async listBoundProjectKeys(
    resolved: ResolvedRepo,
  ): Promise<{ keys: string[]; elsewhere: number }> {
    const repository = this.listedRepository(resolved);
    return { keys: await listBoundProjectKeys(this.api, this.setting, repository), elsewhere: 0 };
  }

  async findExistingProjectKeys(_resolved: ResolvedRepo, projectKeys: string[]): Promise<string[]> {
    const states = await mapWithLimit(projectKeys, async (key) => ({
      key,
      state: await this.api.lookupProject(key),
    }));
    return states.filter(({ state }) => state !== 'missing').map(({ key }) => key);
  }

  async importRepo(resolved: ResolvedRepo): Promise<ImportRepoOutcome | undefined> {
    const repository = this.listedRepository(resolved);
    const projectKey = deriveProjectKey(repository.slug);
    const claimedBy = this.claimedKeys.get(projectKey);
    if (claimedBy !== undefined && claimedBy !== repository.id) {
      throw new CommandFailedError(
        `Repository '${repository.slug}' would get the project key '${projectKey}', already used by another repository in this run.`,
        { remediationHint: 'Import it from SonarQube Server in your browser instead.' },
      );
    }
    this.claimedKeys.set(projectKey, repository.id);
    if (await assertProjectKeyUsable(this.api, this.setting, repository, projectKey)) {
      return { detail: ALREADY_BOUND };
    }
    try {
      await this.api.createBoundProject({
        projectKey,
        projectName: repository.name,
        devOpsPlatformSettingId: this.setting.id,
        repositoryIdentifier: repository.repositoryIdentifier,
        projectIdentifier: repository.projectIdentifier,
      });
    } catch (error) {
      if (
        (error instanceof BadRequestError ||
          (error instanceof UnexpectedApiError && error.status === CREATION_CONFLICT_STATUS)) &&
        (await assertProjectKeyUsable(this.api, this.setting, repository, projectKey))
      ) {
        return { detail: ALREADY_BOUND };
      }
      throw this.explainedImportFailure(error, projectKey);
    }
    return undefined;
  }

  /** One `bound-projects` call per project, in the order given; a failure does not stop the others. */
  async importMonorepo(
    resolved: ResolvedRepo,
    projects: MonorepoProject[],
    report: MonorepoProgressReporter,
  ): Promise<void> {
    const repository = this.listedRepository(resolved);
    // A limit of one keeps the bindings strictly in the order given, one request at a time.
    await runWithConcurrencyLimit(projects, 1, (project) =>
      this.bindMonorepoProject(repository, project, report),
    );
  }

  /** Binds one project to `repository`; a failure is reported, never thrown. */
  private async bindMonorepoProject(
    repository: ServerRepository,
    { projectKey, projectName }: MonorepoProject,
    report: MonorepoProgressReporter,
  ): Promise<void> {
    report(projectKey, 'running');
    try {
      if (await assertProjectKeyUsable(this.api, this.setting, repository, projectKey)) {
        report(projectKey, 'done', ALREADY_BOUND);
        return;
      }
      await this.api.createBoundProject({
        projectKey,
        projectName,
        devOpsPlatformSettingId: this.setting.id,
        repositoryIdentifier: repository.repositoryIdentifier,
        projectIdentifier: repository.projectIdentifier,
        monorepo: true,
      });
      report(projectKey, 'done');
    } catch (error) {
      const failure = this.explainedImportFailure(error, projectKey);
      report(projectKey, 'failed', failure instanceof Error ? failure.message : inspect(failure));
    }
  }

  private listedRepository(resolved: ResolvedRepo): ServerRepository {
    const repository = this.repositories.get(resolved.installationKey);
    if (!repository) {
      throw new CommandFailedError(`Repository '${resolved.slug}' is no longer listed.`);
    }
    return repository;
  }

  private explainedImportFailure(error: unknown, projectKey: string): unknown {
    const reason = explainImportFailure(error, {
      settingKey: this.setting.key,
      platformLabel: DOP_PLATFORM_LABELS[this.setting.type],
      connectUrl: reconnectUrl(this.serverUrl, this.setting, 'missing'),
      reconnectUrl: reconnectUrl(this.serverUrl, this.setting, 'invalid'),
      projectKey,
    });
    return error instanceof Error && reason === error.message
      ? error
      : new CommandFailedError(reason);
  }
}
