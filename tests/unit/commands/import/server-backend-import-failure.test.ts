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

import { describe, expect, it } from 'bun:test';

import type { ServerImportApiClient } from '@/commands/import/server/server-import-api.ts';
import { ServerBackend } from '@/commands/import/server-backend.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { BadRequestError, ServerError } from '@/core/server/errors.ts';
import type { Console } from '@/core/ui/console.ts';

const GITLAB = { id: 'gl-id', key: 'my gitlab', type: 'gitlab' as const };

async function failingImport(putError: Error): Promise<unknown> {
  const api = {
    listDopSettings: () => Promise.resolve([GITLAB]),
    checkPat: () => Promise.resolve('valid' as const),
    searchGitlabRepos: () =>
      Promise.resolve({
        repositories: [{ id: 11, name: 'repo-a', slug: 'repo-a', pathSlug: 'group' }],
        total: 1,
      }),
    lookupProject: () => Promise.resolve('missing'),
    putBoundProject: () => Promise.reject(putError),
  } as unknown as ServerImportApiClient;
  const backend = new ServerBackend(api, 'https://sonarqube.example.com/');

  const plan = await backend.plan({ repo: ['group/repo-a'], nonInteractive: true }, {
    info: () => undefined,
  } as unknown as Console);
  if (plan.selection.kind !== 'batch') throw new Error('expected a batch selection');
  return plan.importRepo(plan.selection.repos[0]).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('ServerBackend when binding a repository fails', () => {
  it('throws the explained reason with the connect URL that resets the token', async () => {
    const error = await failingImport(new BadRequestError('Invalid personal access token'));

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as Error).message).toBe(
      "GitLab rejected the personal access token for setting 'my gitlab'; reconnect at https://sonarqube.example.com/projects/create?mode=gitlab&resetPat=1",
    );
  });

  it('keeps the server message of a platform failure', async () => {
    const message = "Failed to fetch GitLab project with ID '11' from 'https://gitlab.example.com'";
    const error = await failingImport(
      new ServerError(
        500,
        `SonarQube API error: 500 Internal Server Error - ${JSON.stringify({ message })}`,
      ),
    );

    expect((error as Error).message).toContain('GitLab could not return the repository');
    expect((error as Error).message).toContain(`(${message})`);
  });

  it('names the derived project key when it conflicts', async () => {
    const error = await failingImport(
      new BadRequestError(
        "Project with key 'group_repo-a' cannot be bound - configuration mismatch",
      ),
    );

    expect((error as Error).message).toBe(
      "project key 'group_repo-a' already exists with a different name; the CLI did not change it",
    );
  });

  it('rethrows an error it does not recognise unchanged', async () => {
    const original = new ServerError(500, 'SonarQube API error: 500 Internal Server Error - boom');

    expect(await failingImport(original)).toBe(original);
  });
});
