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
import { GENERIC_HTTP_METHODS, type HttpMethod, SonarQubeClient } from '../../../sonarqube/client';
import { print } from '../../../ui/index.js';
import { discoverProject } from '../_common/discovery.js';
import { InvalidOptionError } from '../_common/error.js';

const VALID_METHODS = new Set<string>(GENERIC_HTTP_METHODS);
const METHODS_WITH_BODY = new Set<HttpMethod>(['POST', 'PATCH', 'PUT']);

export interface ApiCommandOptions {
  data?: string;
  org?: string;
  project?: string;
  verbose?: boolean;
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

  const projectContext = await discoverProject(process.cwd());

  const resolvedEndpoint = resolveUrlTemplate(endpoint, {
    project: options.project || projectContext.projectKey,
    organization: options.org || projectContext.organization || auth.orgKey,
  });

  const contentType = resolvedEndpoint.startsWith('/api/v2/') ? 'json' : 'form';

  const client = new SonarQubeClient(auth.serverUrl, auth.token);

  const response = await client.genericRequest(
    upperMethod,
    resolvedEndpoint,
    options.data,
    contentType,
    options.verbose,
  );
  print(response);
}

/**
 * Replace `{key}` placeholders in a URL string with values from a context map.
 * Values are URI-encoded. Throws if a placeholder has no matching context key.
 */
export function resolveUrlTemplate(
  template: string,
  context: Record<string, string | undefined>,
): string {
  return template.replaceAll(/\{(\w+)\}/g, (_match, key: string) => {
    if (!(key in context)) {
      const available = Object.keys(context).join(', ');
      throw new Error(
        `Unknown template variable {${key}}. Available variables: ${available || '(none)'}`,
      );
    }
    if (!context[key]) {
      // Ideally the CLI would be able to tell you the provenance of the variables it found
      throw new Error(
        `Template variable {${key}} could not be resolved from context. Please provide it directly.`,
      );
    }
    return encodeURIComponent(context[key]);
  });
}
