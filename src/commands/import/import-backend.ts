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
import type { RepoResolution, ResolvedRepo } from './resolve-options';
import type { ImportOptions } from './types';

/** What happened to one repository, when more than "imported" is worth saying. */
export interface ImportRepoOutcome {
  detail?: string;
  /** Key of the project the repository was provisioned as, when the backend reports it. */
  projectKey?: string;
}

/** What a backend resolved for one run: which repositories to import, and how to import each. */
export interface ImportPlan {
  selection: RepoResolution;
  projectListUrl: string;
  /** Maps a listed repository to the shape `importRepo` expects. */
  toResolvedRepo(repo: DopRepository): ResolvedRepo;
  /** Provisions a single repository; rejects with the failure reason. */
  importRepo(repo: ResolvedRepo): Promise<ImportRepoOutcome | undefined>;
}

/** One SonarQube flavour's way of resolving the import target and provisioning repositories. */
export interface ImportBackend {
  plan(options: ImportOptions, console: Console): Promise<ImportPlan>;
}
