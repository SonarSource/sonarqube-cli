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

import type { Console } from '@/core/ui/console.ts';

import type { DopRepository } from './import-api.ts';
import type { MonorepoProject } from './monorepo-projects.ts';
import type { RepoResolution, ResolvedRepo } from './resolve-options';
import type { ImportOptions } from './types';

/** What happened to one repository, when more than "imported" is worth saying. */
export interface ImportRepoOutcome {
  detail?: string;
  projectKey?: string;
}

/** Reports one project's progress while a monorepo import runs. */
export type MonorepoProgressReporter = (
  projectKey: string,
  status: 'running' | 'done' | 'failed',
  detail?: string,
) => void;

/** The overview page of one project, for the links shown once it is imported. */
export function projectOverviewUrl(serverUrl: string, projectKey: string): string {
  return `${serverUrl.replace(/\/$/, '')}/project/overview?id=${encodeURIComponent(projectKey)}`;
}

/** What a backend resolved for one run: which repositories to import, and how to import each. */
export interface ImportPlan {
  selection: RepoResolution;
  /** Where to send the user once the import has finished. */
  outroLink: { label: string; url: string };
  /** Where to find one imported project. */
  projectUrl(projectKey: string): string;
  /** Maps a listed repository to the shape `importRepo` expects. */
  toResolvedRepo(repo: DopRepository): ResolvedRepo;
  /** Provisions a single repository; rejects with the failure reason. */
  importRepo(repo: ResolvedRepo): Promise<ImportRepoOutcome | undefined>;
  /** Every project already bound to `repo`; `elsewhere` counts bound projects the CLI cannot name. */
  listBoundProjectKeys(repo: ResolvedRepo): Promise<{ keys: string[]; elsewhere: number }>;
  /** Which of `projectKeys` already exist, so a monorepo import can skip them. */
  findExistingProjectKeys(repo: ResolvedRepo, projectKeys: string[]): Promise<string[]>;
  /**
   * Binds each of `projects` to the one repository `repo`, reporting every project's outcome
   * through `report`. Per-project failures are reported, not thrown.
   */
  importMonorepo(
    repo: ResolvedRepo,
    projects: MonorepoProject[],
    report: MonorepoProgressReporter,
  ): Promise<void>;
}

/** One SonarQube flavour's way of resolving the import target and provisioning repositories. */
export interface ImportBackend {
  plan(options: ImportOptions, console: Console): Promise<ImportPlan>;
}
