/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

import { type ResolvedAuth } from '../../../lib/auth-resolver.js';
import {
  GENERIC_HTTP_METHODS,
  METHODS_WITH_BODY,
  type HttpMethod,
  SonarQubeClient,
} from '../../../sonarqube/client';
import { print } from '../../../ui/index.js';
import { InvalidOptionError } from '../_common/error.js';
import { CLOUD_API_DOCS_URL, SERVER_API_DOCS_URL } from '../../../lib/config-constants.js';

const VALID_METHODS = new Set<string>(GENERIC_HTTP_METHODS);

export interface ApiCommandOptions {
  data?: string;
  verbose?: boolean;
}

export function apiExtraHelpText(): string {
  return `
Examples:
  # List favorite projects
  $ sonar api get "/api/favorites/search"

  # Search for rules in an organization
  $ sonar api get "/api/rules/search?organization=org-name"

  # Generate a new user token
  $ sonar api post "/api/user_tokens/generate" --data '{"name":"my-new-token"}'

  # Accept an issue
  $ sonar api post "/api/issues/do_transition" --data '{"comment":"comment text","issue":"issue-id","transition":"accept"}'

  # Get the current analysis engine JAR (V2 api)
  $ sonar api get "/analysis/engine"

V1 and V2 routing:
  Both cloud and server have V1 and V2 versions of their APIs.
  This tool automatically switches its behavior based on the endpoint path you choose.

API Usage Documentation:
  SonarQube Cloud:  ${CLOUD_API_DOCS_URL}
  SonarQube Server: ${SERVER_API_DOCS_URL}
`;
}

export async function apiCommand(
  auth: ResolvedAuth,
  method: string,
  endpoint: string,
  options: ApiCommandOptions,
): Promise<void> {
  if (!VALID_METHODS.has(method.toUpperCase())) {
    const validMethods = Array.from(VALID_METHODS)
      .map((m) => m.toLowerCase())
      .join(', ');
    throw new InvalidOptionError(
      `Invalid HTTP method '${method}'. Must be one of: ${validMethods}`,
    );
  }

  const upperMethod = method.toUpperCase() as HttpMethod;

  if (!endpoint.startsWith('/')) {
    throw new InvalidOptionError(`Endpoint must start with '/'. Got: ${endpoint}`);
  }

  if (options.data && !METHODS_WITH_BODY.has(upperMethod)) {
    const validDataMethods = Array.from(METHODS_WITH_BODY)
      .map((m) => m.toLowerCase())
      .join(', ');
    throw new InvalidOptionError(`--data is only valid for ${validDataMethods} requests`);
  }

  if (options.data) {
    try {
      JSON.parse(options.data);
    } catch {
      throw new InvalidOptionError(`--data must be valid JSON`);
    }
  }

  let contentType: 'json' | 'form' | undefined;

  // V2 api is JSON, everything else is form data
  if (endpoint.startsWith('/api/v2/') || !endpoint.startsWith('/api/')) {
    contentType = 'json';
  } else {
    contentType = 'form';
  }

  const client = new SonarQubeClient(auth.serverUrl, auth.token);

  const response = await client.genericRequest(
    upperMethod,
    endpoint,
    options.data,
    contentType,
    options.verbose,
  );
  print(response);
}
