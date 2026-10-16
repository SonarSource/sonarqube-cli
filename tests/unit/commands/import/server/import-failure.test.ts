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

import {
  explainImportFailure,
  type ImportFailureContext,
} from '@/commands/import/server/import-failure.ts';
import {
  AccessDeniedError,
  BadRequestError,
  ForbiddenApiError,
  ServerError,
  TransportError,
  UnexpectedApiError,
} from '@/core/server/errors.ts';

const CONNECT_URL = 'https://sonar.example.com/projects/create?mode=gitlab';
const RECONNECT_URL = `${CONNECT_URL}&resetPat=1`;
const CREATE_PROJECTS_REASON = "you need the 'Create Projects' permission to import repositories";
const KEY_NOT_ADMINISTERED_MESSAGE =
  'You do not have access to this resource or it does not exist.';

function context(platformLabel = 'GitLab'): ImportFailureContext {
  return {
    settingKey: 'my-gitlab',
    platformLabel,
    connectUrl: CONNECT_URL,
    reconnectUrl: RECONNECT_URL,
    projectKey: 'group_repo-a',
  };
}

/** What the HTTP client builds for a PUT failure other than 400/403: the status line and the raw body. */
function serverFailure(status: number, statusText: string, message: string) {
  const body = `SonarQube API error: ${status} ${statusText} - ${JSON.stringify({ message })}`;
  return status >= 500 ? new ServerError(status, body) : new UnexpectedApiError(status, body);
}

function platformReason(label: string): string {
  return `${label} could not return the repository: check the token and that the repository is visible to it; reconnect at ${CONNECT_URL}`;
}

describe('explainImportFailure', () => {
  describe('missing token', () => {
    it.each([
      ["personal access token for 'my-gitlab' is missing"],
      ["Personal access token for 'my-gitlab' is missing"],
      ['No personal access token found'],
    ])('explains %p', (message) => {
      expect(explainImportFailure(new BadRequestError(message), context())).toBe(
        `no personal access token is connected for GitLab setting 'my-gitlab'; connect it at ${CONNECT_URL}`,
      );
    });
  });

  describe('rejected token', () => {
    it.each([
      ['Invalid personal access token'],
      ['Your GitLab token was revoked'],
      ['Your GitLab token is expired'],
      ['Your GitLab token has insufficient scope'],
      ['Forbidden access to GitLab'],
      ['Unable to contact Bitbucket Cloud servers [HTTP 401]'],
    ])('explains a 400 %p', (message) => {
      expect(explainImportFailure(new BadRequestError(message), context())).toBe(
        `GitLab rejected the personal access token for setting 'my-gitlab'; reconnect at ${RECONNECT_URL}`,
      );
    });

    it.each([
      ['Unable to contact Bitbucket Cloud servers [HTTP 401]'],
      ['Error returned by Bitbucket Cloud: Forbidden [HTTP 403]'],
    ])('explains a 500 with the Bitbucket Cloud message %p', (message) => {
      expect(
        explainImportFailure(
          serverFailure(500, 'Internal Server Error', message),
          context('Bitbucket Cloud'),
        ),
      ).toBe(
        `Bitbucket Cloud rejected the personal access token for setting 'my-gitlab'; reconnect at ${RECONNECT_URL}`,
      );
    });
  });

  describe('the platform could not return the repository', () => {
    it.each([
      [
        'GitHub',
        "Impossible to find the repository 'acme/api' on GitHub, using the devops config my-github",
      ],
      ['GitLab', "Failed to fetch GitLab project with ID '42' from 'https://gitlab.example.com'"],
      [
        'Azure DevOps',
        "Failed to fetch AzureDevOps repository 'repo' from project 'proj' from 'https://dev.azure.com/org'",
      ],
      ['Bitbucket Cloud', 'Error returned by Bitbucket Cloud: Repository not found [HTTP 404]'],
    ])('explains the %s 500 and keeps the server message', (label, message) => {
      expect(
        explainImportFailure(serverFailure(500, 'Internal Server Error', message), context(label)),
      ).toBe(`${platformReason(label)} (${message})`);
    });

    it('reads the message from a body without the status prefix', () => {
      const error = new ServerError(500, '{"message":"Impossible to find the repository \'x\'"}');

      expect(explainImportFailure(error, context('GitHub'))).toBe(
        `${platformReason('GitHub')} (Impossible to find the repository 'x')`,
      );
    });
  });

  describe('the platform is unreachable', () => {
    it.each([
      ['Unable to contact Bitbucket server'],
      ['Error 404. The requested Bitbucket server is unreachable.'],
    ])('explains the 400 %p', (message) => {
      expect(explainImportFailure(new BadRequestError(message), context('Bitbucket Server'))).toBe(
        `SonarQube could not reach Bitbucket Server; check the DevOps platform setting 'my-gitlab' (${message})`,
      );
    });
  });

  describe('missing permission', () => {
    it('explains a ForbiddenApiError carrying the v2 body', () => {
      const error = new ForbiddenApiError('{"message":"Insufficient privileges"}');

      expect(explainImportFailure(error, context())).toBe(CREATE_PROJECTS_REASON);
    });

    it('explains an AccessDeniedError 403', () => {
      expect(explainImportFailure(new AccessDeniedError(403), context())).toBe(
        CREATE_PROJECTS_REASON,
      );
    });

    it('explains a 403 surfaced as UnexpectedApiError', () => {
      expect(
        explainImportFailure(serverFailure(403, 'Forbidden', 'Insufficient privileges'), context()),
      ).toBe(CREATE_PROJECTS_REASON);
    });
  });

  describe('unauthenticated', () => {
    it('explains a 401', () => {
      expect(
        explainImportFailure(
          serverFailure(401, 'Unauthorized', 'Authentication is required'),
          context(),
        ),
      ).toBe("SonarQube rejected the CLI's credentials (401); run 'sonar auth login'");
    });
  });

  describe('project key conflicts', () => {
    it('explains a 404 as a key owned by a project the caller cannot administer', () => {
      const error = serverFailure(404, 'Not Found', KEY_NOT_ADMINISTERED_MESSAGE);

      expect(explainImportFailure(error, context())).toBe(
        "project key 'group_repo-a' already exists and you cannot administer it; the CLI did not change it",
      );
    });

    it('does not name a key it was not given', () => {
      const error = serverFailure(404, 'Not Found', KEY_NOT_ADMINISTERED_MESSAGE);

      expect(explainImportFailure(error, { ...context(), projectKey: undefined })).toBe(
        'project key derived from the repository path already exists and you cannot administer it; the CLI did not change it',
      );
    });

    it('explains a configuration mismatch with the key from the server message', () => {
      const error = new BadRequestError(
        "Project with key 'group_repo-a' cannot be bound - configuration mismatch",
      );

      expect(explainImportFailure(error, context())).toBe(
        "project key 'group_repo-a' already exists with a different name; the CLI did not change it",
      );
    });

    it('leaves a 404 that is not about access untouched', () => {
      const error = serverFailure(404, 'Not Found', 'Unknown url : /api/v2/dop-translation');

      expect(explainImportFailure(error, context())).toBe(error.message);
    });

    it('leaves an AccessDeniedError 404 untouched', () => {
      const error = new AccessDeniedError(404);

      expect(explainImportFailure(error, context())).toBe(error.message);
    });
  });

  describe('malformed key or name', () => {
    it.each([
      ["Malformed key for Project: 'a b'. Allowed characters are alphanumeric, '-', '_', '.', ':'"],
      ['Component key length (401) is longer than the maximum authorized (400)'],
    ])('explains the key message %p', (message) => {
      expect(explainImportFailure(new BadRequestError(message), context())).toBe(
        `the project key derived from the repository path is not valid (${message})`,
      );
    });

    it('explains the name message', () => {
      const message = 'Component name length (501) is longer than the maximum authorized (500)';

      expect(explainImportFailure(new BadRequestError(message), context())).toBe(
        `the repository name is not valid as a project name (${message})`,
      );
    });
  });

  describe('unknown setting', () => {
    it('explains a vanished setting', () => {
      const error = new BadRequestError(
        'devOpsPlatformSettingId value not found, the DevOps platform setting may have been deleted',
      );

      expect(explainImportFailure(error, context())).toBe(
        "DevOps platform setting 'my-gitlab' was not found on the server; it may have been removed",
      );
    });
  });

  describe('unknown errors', () => {
    it.each([
      ['a 400 about something else', new BadRequestError('Something unexpected happened')],
      [
        'a 500 about something else',
        serverFailure(500, 'Internal Server Error', 'Database is down'),
      ],
      ['a transport failure', new TransportError('connect ECONNREFUSED 127.0.0.1:9000')],
    ])('keeps the original message for %s', (_name, error) => {
      expect(explainImportFailure(error, context())).toBe(error.message);
    });

    it('stringifies a thrown value that is not an Error', () => {
      expect(explainImportFailure('boom', context())).toBe('boom');
    });
  });

  it.each([
    new BadRequestError("personal access token for 'my-gitlab' is missing"),
    new BadRequestError('Invalid personal access token'),
    serverFailure(500, 'Internal Server Error', 'Failed to fetch GitLab project with ID 1'),
    new ForbiddenApiError('{"message":"Insufficient privileges"}'),
    serverFailure(404, 'Not Found', KEY_NOT_ADMINISTERED_MESSAGE),
  ])('always answers with a single line (%#)', (error) => {
    expect(explainImportFailure(error, context())).not.toContain('\n');
  });
});
