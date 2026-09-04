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

// The Vortex analysis endpoint, wrapped next to the command that drives it.

import { ForbiddenApiError, SqaaForbiddenError } from '@/core/server/errors.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';
import { INVOCATION_ID, SONAR_INVOCATION_ID_HEADER } from '@/core/telemetry/invocation-id.ts';

import type { SqaaAnalysisRequest, SqaaAnalysisResponse } from './sqaa-wire-types.ts';

export class SqaaAnalysisClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  /**
   * Create a Vortex analysis (single- or multi-file). On Cloud the endpoint lives on the
   * region-specific API host; on Server the A3S hub serves it from the instance itself.
   */
  async createAnalysis(request: SqaaAnalysisRequest): Promise<SqaaAnalysisResponse> {
    const endpoint = this.client.isCloud ? '/a3s-analysis/analyses' : '/api/v2/a3s/analyses';
    const result = await this.client.post<SqaaAnalysisResponse>(
      endpoint,
      request,
      this.client.apiHostFor(endpoint),
      { [SONAR_INVOCATION_ID_HEADER]: INVOCATION_ID },
    );
    if (!result.ok) {
      // 403 on this endpoint means Agentic Pack entitlement was revoked.
      if (result.error instanceof ForbiddenApiError) {
        throw new SqaaForbiddenError();
      }
      throw result.error;
    }
    return result.value;
  }
}
