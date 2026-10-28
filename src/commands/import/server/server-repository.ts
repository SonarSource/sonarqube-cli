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

import type { DopPlatform, DopSetting, ServerImportApiClient } from './server-import-api.ts';

/** A repository on a DevOps platform, whichever platform it comes from. */
export interface ServerRepository {
  /** Stable id of the repository, unique within one setting. */
  id: string;
  name: string;
  /** What the user types for `--repo` and sees in lists, e.g. `group/subgroup/repo`. */
  slug: string;
  /** What the server expects as `repositoryIdentifier` for this platform. */
  repositoryIdentifier: string;
  /** What the server expects as `projectIdentifier`; Azure DevOps and Bitbucket Server only. */
  projectIdentifier?: string;
  /** Key of the SonarQube project already bound to it, if any. */
  boundProjectKey?: string;
}

export type ServerRepositoryPage = { repositories: ServerRepository[]; total: number };

/**
 * Fetches one page of repositories (`pageIndex` starts at 1). Called with consecutive indices,
 * and again with the same index after a failure. A page shorter than `pageSize` is the last one.
 */
export type FetchServerRepositories = (
  pageIndex: number,
  pageSize: number,
) => Promise<ServerRepositoryPage>;

export interface PlatformSupport {
  listRepositories(api: ServerImportApiClient, setting: DopSetting): FetchServerRepositories;
}

export type SupportedPlatforms = Partial<Record<DopPlatform, PlatformSupport>>;
