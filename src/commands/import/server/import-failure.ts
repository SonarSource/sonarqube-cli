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

import {
  AccessDeniedError,
  BadRequestError,
  ForbiddenApiError,
  ServerError,
  UnexpectedApiError,
} from '@/core/server/errors.ts';
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_NOT_FOUND,
} from '@/core/server/http-constants.ts';

import { patStatusFromError } from './pat-status.ts';

export interface ImportFailureContext {
  settingKey: string;
  platformLabel: string;
  /** Where the user connects a token that is missing or may be fine. */
  connectUrl: string;
  /** Where the user replaces a token the platform rejected. */
  reconnectUrl: string;
  /** The key the CLI derived for the repository, named in the project-key conflict reasons. */
  projectKey?: string;
}

const HTTP_STATUS_UNAUTHORIZED = 401;
const STATUS_PREFIX = /^SonarQube API error: \d{3} .*? - /s;
const BITBUCKET_CLOUD_REJECTION = /\[http 40[13]\]/i;
const PLATFORM_FETCH_FAILURE =
  /impossible to find the repository|failed to fetch (?:gitlab project|azuredevops repository)|error returned by bitbucket cloud/i;
const PLATFORM_UNREACHABLE = /unable to contact bitbucket server|bitbucket server is unreachable/i;
const KEY_OWNED_BY_OTHERS = /do not have access to this resource/i;
const KEY_NAME_MISMATCH = /project with key '([^']*)' cannot be bound/i;
const MALFORMED_KEY = /malformed key|component key length/i;
const MALFORMED_NAME = /component name length/i;
const UNKNOWN_SETTING = /devopsplatformsettingid value not found/i;

/**
 * A short, actionable reason for a failed `PUT /api/v2/dop-translation/bound-projects`.
 * Errors it does not recognise keep their original message.
 */
export function explainImportFailure(error: unknown, context: ImportFailureContext): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const message = serverMessage(error);
  const status = statusOf(error);
  const { settingKey, platformLabel, connectUrl, reconnectUrl, projectKey } = context;

  const tokenStatus = error instanceof BadRequestError ? patStatusFromError(error) : undefined;
  if (tokenStatus === 'missing') {
    return `no personal access token is connected for ${platformLabel} setting '${settingKey}'; connect it at ${connectUrl}`;
  }
  if (
    tokenStatus === 'invalid' ||
    (status !== HTTP_STATUS_BAD_REQUEST &&
      status !== undefined &&
      BITBUCKET_CLOUD_REJECTION.test(message))
  ) {
    return `${platformLabel} rejected the personal access token for setting '${settingKey}'; reconnect at ${reconnectUrl}`;
  }
  if (PLATFORM_FETCH_FAILURE.test(message)) {
    return `${platformLabel} could not return the repository: check the token and that the repository is visible to it; reconnect at ${connectUrl} (${message})`;
  }
  if (PLATFORM_UNREACHABLE.test(message)) {
    return `SonarQube could not reach ${platformLabel}; check the DevOps platform setting '${settingKey}' (${message})`;
  }
  if (status === HTTP_STATUS_FORBIDDEN) {
    return "you need the 'Create Projects' permission to import repositories";
  }
  if (status === HTTP_STATUS_UNAUTHORIZED) {
    return "SonarQube rejected the CLI's credentials (401); run 'sonar auth login'";
  }
  if (status === HTTP_STATUS_NOT_FOUND && KEY_OWNED_BY_OTHERS.test(message)) {
    return `project key ${quoted(projectKey)} already exists and you cannot administer it; the CLI did not change it`;
  }
  const mismatch = KEY_NAME_MISMATCH.exec(message);
  if (mismatch) {
    return `project key '${mismatch[1]}' already exists with a different name; the CLI did not change it`;
  }
  if (MALFORMED_KEY.test(message)) {
    return `the project key derived from the repository path is not valid (${message})`;
  }
  if (MALFORMED_NAME.test(message)) {
    return `the repository name is not valid as a project name (${message})`;
  }
  if (UNKNOWN_SETTING.test(message)) {
    return `DevOps platform setting '${settingKey}' was not found on the server; it may have been removed`;
  }
  return error.message;
}

function quoted(projectKey: string | undefined): string {
  return projectKey === undefined ? 'derived from the repository path' : `'${projectKey}'`;
}

function statusOf(error: Error): number | undefined {
  if (error instanceof BadRequestError) return HTTP_STATUS_BAD_REQUEST;
  if (error instanceof ForbiddenApiError) return HTTP_STATUS_FORBIDDEN;
  if (
    error instanceof ServerError ||
    error instanceof UnexpectedApiError ||
    error instanceof AccessDeniedError
  ) {
    return error.status;
  }
  return undefined;
}

/** The server's own message: the v2 error body's `message`, without the client's status prefix. */
function serverMessage(error: Error): string {
  const text = error.message.replace(STATUS_PREFIX, '');
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === 'object' && body !== null && 'message' in body) {
      const { message } = body;
      if (typeof message === 'string' && message) return message;
    }
  } catch {
    // not JSON: the text itself is the message
  }
  return text;
}
