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

import { version as VERSION } from '../../package.json';

const REQUEST_TIMEOUT_MS = 30000;

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export type ContentType = 'json' | 'form';

export interface ApiResponse {
  status: number;
  statusText: string;
  body: string;
  headers: Headers;
}

/**
 * Make an authenticated HTTP request to a SonarQube API endpoint.
 * Returns raw response data — does NOT throw on non-2xx status codes.
 */
export async function apiRequest(
  method: HttpMethod,
  url: string,
  token: string,
  data?: string,
  contentType: ContentType = 'json',
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'User-Agent': `sonarqube-cli/${VERSION}`,
    Accept: 'application/json',
  };

  let requestBody: string | undefined;

  if (data && (method === 'POST' || method === 'PATCH')) {
    if (contentType === 'form') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(parsed)) {
        params.set(key, String(value));
      }
      requestBody = params.toString();
    } else {
      headers['Content-Type'] = 'application/json';
      requestBody = data;
    }
  }

  const response = await fetch(url, {
    method,
    headers,
    body: requestBody,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const body = await response.text();

  return {
    status: response.status,
    statusText: response.statusText,
    body,
    headers: response.headers,
  };
}
