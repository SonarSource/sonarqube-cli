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

import type { FetchServerRepositories } from './server-repository.ts';

/**
 * What the server answers when Azure DevOps replies to a listing with something that is not JSON:
 * an invalid or expired token can get a sign-in page (HTTP 203 or a redirect) that the server's
 * own token check accepts as success.
 */
const UNUSABLE_AZURE_RESPONSE = /unable to contact azure devops server|could not be parsed/i;

/**
 * Makes the first page of an Azure DevOps listing explain itself when it cannot be trusted: either
 * the server could not read Azure's answer, or the token sees no repository at all. Both usually
 * mean a dead token that the token check let through, so the user is sent to reconnect it.
 */
export function guardAzureSignIn(
  fetchPage: FetchServerRepositories,
  reconnectUrl: string,
): FetchServerRepositories {
  return async (pageIndex, pageSize) => {
    if (pageIndex !== 1) {
      return fetchPage(pageIndex, pageSize);
    }
    let page;
    try {
      page = await fetchPage(pageIndex, pageSize);
    } catch (error) {
      throw error instanceof BadRequestError && UNUSABLE_AZURE_RESPONSE.test(error.message)
        ? noRepositoryError(reconnectUrl)
        : error;
    }
    if (page.repositories.length === 0) {
      throw noRepositoryError(reconnectUrl);
    }
    return page;
  };
}

function noRepositoryError(reconnectUrl: string): CommandFailedError {
  return new CommandFailedError(
    'Azure DevOps did not return any repository. The token may be invalid or expired (Azure DevOps can answer an invalid token with a sign-in page that looks like success), or the token cannot see any project.',
    { remediationHint: `Reconnect it at ${reconnectUrl}, then run 'sonar import' again.` },
  );
}
