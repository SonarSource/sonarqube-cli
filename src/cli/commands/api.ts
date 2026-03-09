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

import { resolveAuth } from '../../lib/auth-resolver.js';
import { apiRequest } from '../../lib/api-request.js';
import { resolveUrlTemplate } from '../../lib/url-template.js';
import { discoverProject } from '../../bootstrap/discovery.js';
import {
  SONARCLOUD_API_URL,
  SONARCLOUD_HOSTNAME,
  SONARCLOUD_URL,
} from '../../lib/config-constants.js';
import { InvalidOptionError } from './common/error.js';
import { print } from '../../ui/index.js';
import type { ContentType, HttpMethod } from '../../lib/api-request.js';

const VALID_METHODS = new Set(['get', 'post', 'patch', 'delete']);
const METHODS_WITH_BODY = new Set(['post', 'patch']);
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;

export interface ApiCommandOptions {
  server?: string;
  token?: string;
  org?: string;
  data?: string;
}

export async function apiCommand(
  method: string,
  endpoint: string,
  options: ApiCommandOptions,
): Promise<void> {
  const lowerMethod = method.toLowerCase();

  if (!VALID_METHODS.has(lowerMethod)) {
    throw new InvalidOptionError(
      `Invalid HTTP method '${method}'. Must be one of: get, post, patch, delete`,
    );
  }

  if (!endpoint.startsWith('/')) {
    throw new InvalidOptionError(`Endpoint must start with '/'. Got: ${endpoint}`);
  }

  if (options.data && !METHODS_WITH_BODY.has(lowerMethod)) {
    throw new InvalidOptionError(`--data is only valid for POST and PATCH requests`);
  }

  if (options.data) {
    try {
      JSON.parse(options.data);
    } catch {
      throw new InvalidOptionError(`--data must be valid JSON`);
    }
  }

  const auth = await resolveAuth({
    token: options.token,
    server: options.server,
    org: options.org,
  });

  // Build template context from available values
  const templateContext: Record<string, string> = {};
  if (auth.orgKey) {
    templateContext.organization = auth.orgKey;
  }

  try {
    const project = await discoverProject(process.cwd());
    if (project.sonarPropsData?.projectKey) {
      templateContext.project = project.sonarPropsData.projectKey;
    }
  } catch {
    // Project discovery is best-effort — no project template variable available
  }

  const resolvedEndpoint = resolveUrlTemplate(endpoint, templateContext);
  const baseUrl = resolveBaseUrl(auth.serverUrl, resolvedEndpoint);
  const url = `${baseUrl}${resolvedEndpoint}`;
  const contentType: ContentType = resolvedEndpoint.startsWith('/api/v2/') ? 'json' : 'form';

  const response = await apiRequest(
    lowerMethod.toUpperCase() as HttpMethod,
    url,
    auth.token,
    options.data,
    contentType,
  );

  if (response.body) {
    print(response.body);
  }

  if (response.status < HTTP_OK_MIN || response.status > HTTP_OK_MAX) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
}

/**
 * Determine the base URL for a request. SonarCloud uses separate hosts:
 * - sonarcloud.io for /api/... endpoints
 * - api.sonarcloud.io for all other endpoints
 */
export function resolveBaseUrl(serverUrl: string, endpoint: string): string {
  const normalized = serverUrl.replace(/\/$/, '');
  try {
    const url = new URL(normalized);
    if (url.hostname === SONARCLOUD_HOSTNAME) {
      return endpoint.startsWith('/api') ? SONARCLOUD_URL : SONARCLOUD_API_URL;
    }
  } catch {
    // Not a valid URL — fall through to use as-is
  }
  return normalized;
}
