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

type KeyGuardApi = Pick<ServerImportApiClient, 'lookupProject' | 'findProjectBinding'>;

enum ProjectKeyState {
  Missing = 'missing',
  Matching = 'matching',
  Conflicting = 'conflicting',
}

/** The keys of every project bound to this repository, whether or not the CLI created them. */
export async function listBoundProjectKeys(
  api: Pick<ServerImportApiClient, 'findProjectBinding'>,
  setting: DopSetting,
  repository: ServerRepository,
): Promise<string[]> {
  const keys = new Set<string>();
  // The matcher collects instead of matching, so the call reads every page of bindings.
  await api.findProjectBinding(setting.id, repository.repositoryIdentifier, (candidate) => {
    if (
      candidate.devOpsPlatformSettingId === setting.id &&
      bindsRepository(candidate, setting, repository)
    ) {
      keys.add(candidate.projectKey);
    }
    return false;
  });
  return [...keys];
}

/** Returns whether the existing project is already bound to this repository. */
export async function assertProjectKeyUsable(
  api: KeyGuardApi,
  setting: DopSetting,
  repository: ServerRepository,
  projectKey: string,
): Promise<boolean> {
  let state: ProjectKeyState;
  try {
    state = await projectKeyState(api, setting, repository, projectKey);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CommandFailedError(
      `Could not check whether a project with key '${projectKey}' already exists: ${reason}`,
    );
  }
  if (state === ProjectKeyState.Conflicting) {
    throw new CommandFailedError(
      `A project with key '${projectKey}' already exists and is not bound to ${repository.slug}; the CLI did not change it.`,
      {
        remediationHint:
          'Delete or rename that project, or bind it to this repository in SonarQube, then retry.',
      },
    );
  }
  return state === ProjectKeyState.Matching;
}

async function projectKeyState(
  api: KeyGuardApi,
  setting: DopSetting,
  repository: ServerRepository,
  projectKey: string,
): Promise<ProjectKeyState> {
  const found = await api.lookupProject(projectKey);
  if (found !== 'found') {
    return found === 'hidden' ? ProjectKeyState.Conflicting : ProjectKeyState.Missing;
  }
  const binding = await api.findProjectBinding(
    setting.id,
    repository.repositoryIdentifier,
    (candidate) =>
      candidate.projectKey === projectKey &&
      candidate.devOpsPlatformSettingId === setting.id &&
      bindsRepository(candidate, setting, repository),
  );
  return binding === undefined ? ProjectKeyState.Conflicting : ProjectKeyState.Matching;
}

export function bindsRepository(
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
