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
import { NetworkConfigError } from '@/core/errors.ts';
import { MCP_DEFAULT_TOOLSETS } from '@/core/host/mcp/mcp-helper.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import {
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_OK,
  HTTP_STATUS_UNAUTHORIZED,
} from '@/core/server/http-constants.ts';
import { resolveFromEndpoint } from '@/core/server/sonarcloud-region.ts';

const MCP_ENDPOINT = '/mcp';
const HEALTH_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 60000;

type HostedAvailability = { available: boolean; reason: string | null };

export class HostedMcpClient {
  readonly url: string;

  constructor(private readonly connection: SonarConnection) {
    this.url = `${resolveFromEndpoint(connection.httpClient.baseUrl, MCP_ENDPOINT)}${MCP_ENDPOINT}`;
  }

  async checkHealth(): Promise<HostedAvailability> {
    const result = await this.connection.httpClient.getSafe<undefined>(
      `${MCP_ENDPOINT}/health`,
      undefined,
      HEALTH_TIMEOUT_MS,
    );
    if (result.isErr()) {
      if (result.error instanceof NetworkConfigError) throw result.error;
      return { available: false, reason: 'health check failed' };
    }
    const status = result.value.response.status;
    if (status === HTTP_STATUS_UNAUTHORIZED || status === HTTP_STATUS_FORBIDDEN) {
      throw new CommandFailedError(
        `Hosted MCP health check at ${this.url}/health returned HTTP ${status}.`,
        {
          remediationHint:
            "Run 'sonar auth login' with a valid user token that can access this server.",
        },
      );
    }
    return status === HTTP_STATUS_OK
      ? { available: true, reason: null }
      : { available: false, reason: `health check returned HTTP ${status}` };
  }

  request(
    init: RequestInit,
    options: { readOnly?: boolean; toolsets?: string },
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.connection.auth.orgKey) headers.set('SONARQUBE_ORG', this.connection.auth.orgKey);
    if (options.readOnly) headers.set('SONARQUBE_READ_ONLY', 'true');
    headers.set('SONARQUBE_TOOLSETS', options.toolsets ?? MCP_DEFAULT_TOOLSETS);
    // Bound HTTP sends as well as MCP replies; GET is the long-lived notification stream.
    const signal =
      init.method === 'GET'
        ? init.signal
        : AbortSignal.any([
            ...(init.signal ? [init.signal] : []),
            AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ]);
    return this.connection.httpClient.requestRaw(MCP_ENDPOINT, { ...init, headers, signal });
  }
}
