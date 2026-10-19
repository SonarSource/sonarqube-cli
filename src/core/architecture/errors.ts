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
import { AccessDeniedError, BadRequestError, ForbiddenApiError } from '@/core/server/errors.ts';
import { HTTP_STATUS_FORBIDDEN } from '@/core/server/http-constants.ts';

const PLAN_HINT =
  'Architecture needs SonarQube Cloud Team or Enterprise, or the Architecture feature on SonarQube Server.';

/** Translates an HTTP failure of an architecture call into a message that says what to do. */
export function toArchitectureError(error: unknown, projectKey: string): unknown {
  if (error instanceof AccessDeniedError) {
    if (error.status === HTTP_STATUS_FORBIDDEN) {
      return new CommandFailedError(
        `The Architecture API refused access to '${projectKey}' (HTTP 403).`,
        {
          cause: error,
          remediationHint: `Check project permissions, feature availability and API routing for this environment. ${PLAN_HINT}`,
        },
      );
    }
    return new CommandFailedError(
      `Project '${projectKey}' or its architecture was not found on this server.`,
      {
        cause: error,
        remediationHint: `Check the project key with 'sonar list projects'. ${PLAN_HINT}`,
      },
    );
  }
  if (error instanceof ForbiddenApiError) {
    return new CommandFailedError(
      `SonarQube refused the change: ${backendMessage(error.message)}`,
      {
        cause: error,
        remediationHint: `Changing the architecture needs the Administer Architecture permission on the project. ${PLAN_HINT}`,
      },
    );
  }
  if (error instanceof BadRequestError) {
    return new CommandFailedError(`SonarQube rejected the request: ${error.message}`, {
      cause: error,
    });
  }
  return error;
}

/** The `message` of a JSON error body, or the body itself. */
function backendMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
  } catch {
    // not JSON: relay the text as it is
  }
  return body || 'forbidden';
}
