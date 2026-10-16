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

import { describe, expect, it, mock } from 'bun:test';

import { azureSupport } from '@/commands/import/server/azure.ts';
import { guardAzureSignIn } from '@/commands/import/server/azure-sign-in.ts';
import type {
  DopSetting,
  ServerImportApiClient,
} from '@/commands/import/server/server-import-api.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { BadRequestError } from '@/core/server/errors.ts';

const SETTING: DopSetting = { id: 'az-id', key: 'my-azure', type: 'azure' };
const RECONNECT_URL = 'https://sq.example.com/projects/create?mode=azure&resetPat=1';

function guardedLister(api: Partial<ServerImportApiClient>) {
  return guardAzureSignIn(
    azureSupport.listRepositories(api as ServerImportApiClient, SETTING),
    RECONNECT_URL,
  );
}

async function failureOf(promise: Promise<unknown>): Promise<CommandFailedError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CommandFailedError);
  return error as CommandFailedError;
}

describe('guardAzureSignIn', () => {
  it('leaves a non-empty first page unchanged', async () => {
    const fetch = guardedLister({
      searchAzureRepos: () => Promise.resolve([{ name: 'api', projectName: 'A' }]),
    });
    const page = await fetch(1, 50);
    expect(page.repositories.map((r) => r.id)).toEqual(['A/api']);
    expect(page.total).toBe(1);
  });

  it('explains an empty first page and points to the reconnect URL', async () => {
    const fetch = guardedLister({ searchAzureRepos: () => Promise.resolve([]) });
    const error = await failureOf(fetch(1, 50));
    expect(error.message).toContain('Azure DevOps did not return any repository');
    expect(error.message).toContain('invalid or expired');
    expect(error.message).toContain('cannot see any project');
    expect(error.remediationHint).toContain(RECONNECT_URL);
  });

  it.each([
    'Unable to contact Azure DevOps server: https://dev.azure.com/org/_apis/projects?api-version=3.0 timed out',
    'Response from Azure for request [https://dev.azure.com/org/_apis/git/repositories] could not be parsed: [Expected BEGIN_OBJECT but was STRING]',
  ])('maps the server failing to read Azure DevOps (%#) to the same error', async (message) => {
    const fetch = guardedLister({
      searchAzureRepos: mock(() => Promise.reject(new BadRequestError(message))),
    });
    const error = await failureOf(fetch(1, 50));
    expect(error.message).toContain('Azure DevOps did not return any repository');
    expect(error.remediationHint).toContain(RECONNECT_URL);
  });

  it('lets any other failure through untouched', async () => {
    const badUrl = new BadRequestError('Invalid Azure URL');
    const fetch = guardedLister({ searchAzureRepos: () => Promise.reject(badUrl) });
    expect(await fetch(1, 50).catch((e: unknown) => e)).toBe(badUrl);

    const network = new Error('connection reset');
    const other = guardedLister({ searchAzureRepos: () => Promise.reject(network) });
    expect(await other(1, 50).catch((e: unknown) => e)).toBe(network);
  });

  it('only judges the first page', async () => {
    const fetch = guardedLister({
      searchAzureRepos: () => Promise.resolve([{ name: 'api', projectName: 'A' }]),
    });
    await fetch(1, 1);
    expect((await fetch(2, 1)).repositories).toEqual([]);
  });
});
