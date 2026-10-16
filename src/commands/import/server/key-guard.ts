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

import type {
  DopSetting,
  ProjectBindingResponse,
  ServerImportApiClient,
} from './server-import-api.ts';
import type { ServerRepository } from './server-repository.ts';

type KeyGuardApi = Pick<ServerImportApiClient, 'lookupProject' | 'searchProjectBindings'>;

/**
 * `PUT bound-projects` overwrites the binding of an existing project with the same key, so the
 * import may only go ahead when the key is free or already belongs to this repository.
 */
export async function assertProjectKeyUsable(
  api: KeyGuardApi,
  setting: DopSetting,
  repository: ServerRepository,
  projectKey: string,
): Promise<void> {
  let takenByAnother: boolean;
  try {
    takenByAnother = await isTakenByAnother(api, setting, repository, projectKey);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CommandFailedError(
      `Could not check whether a project with key '${projectKey}' already exists: ${reason}`,
    );
  }
  if (takenByAnother) {
    throw new CommandFailedError(
      `A project with key '${projectKey}' already exists and is not bound to ${repository.slug}; the CLI did not change it.`,
      {
        remediationHint:
          'Delete or rename that project, or bind it to this repository in SonarQube, then retry.',
      },
    );
  }
}

async function isTakenByAnother(
  api: KeyGuardApi,
  setting: DopSetting,
  repository: ServerRepository,
  projectKey: string,
): Promise<boolean> {
  const found = await api.lookupProject(projectKey);
  if (found !== 'found') {
    return found === 'hidden';
  }
  const bindings = await api.searchProjectBindings(setting.id, repository.repositoryIdentifier);
  return !bindings.some(
    (binding) =>
      binding.projectKey === projectKey &&
      binding.devOpsPlatformSettingId === setting.id &&
      bindsRepository(binding, setting, repository),
  );
}

function bindsRepository(
  binding: ProjectBindingResponse,
  setting: DopSetting,
  { repositoryIdentifier, projectIdentifier }: ServerRepository,
): boolean {
  if (setting.type === 'azure') {
    return same(binding.repository, repositoryIdentifier) && same(binding.slug, projectIdentifier);
  }
  if (setting.type === 'bitbucket') {
    return same(binding.repository, projectIdentifier) && same(binding.slug, repositoryIdentifier);
  }
  return same(binding.repository, repositoryIdentifier);
}

function same(actual: string | null | undefined, expected: string | undefined): boolean {
  return expected !== undefined && actual?.toLowerCase() === expected.toLowerCase();
}
