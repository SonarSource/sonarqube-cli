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

import { spyOn } from 'bun:test';

import { okAsync, type ResultAsync } from '@/core/result.ts';
import type { SafeGetResult } from '@/core/server/http-client.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

interface ApiStep {
  ok: boolean;
  /** HTTP status for a failing step. Defaults to 500 (a critical, retryable failure). */
  status?: number;
  id?: string;
  uuidV4?: string;
  enterpriseId?: string;
}

/**
 * Builds a `Response`-shaped stub realistic enough for `SonarHttpClient.get()`'s error
 * classification (`buildStatusError`) to run without throwing: it reads `status` and, for
 * non-403/404 statuses, calls `.text()`.
 */
function fakeStepResponse(step: ApiStep): Response {
  const status = step.ok ? 200 : (step.status ?? 500);
  return {
    ok: step.ok,
    status,
    statusText: step.ok ? 'OK' : 'Error',
    url: '',
    text: () => Promise.resolve(''),
  } as Response;
}

interface IdentityApiMockOptions {
  user?: ApiStep[];
  org?: ApiStep[];
  enterprise?: ApiStep[];
  status?: ApiStep[];
}

function shiftStep(queue: ApiStep[] | undefined, fallback: ApiStep): ApiStep {
  return queue?.shift() ?? fallback;
}

/** Mock SonarHttpClient.getSafe for telemetry identity resolver tests. */
export function mockIdentityGetSafe(
  options: IdentityApiMockOptions = {},
): ReturnType<typeof spyOn> {
  const prototype = SonarHttpClient.prototype as {
    getSafe?: ReturnType<typeof spyOn>;
  };
  prototype.getSafe?.mockRestore?.();

  const userSteps = options.user ? [...options.user] : undefined;
  const orgSteps = options.org ? [...options.org] : undefined;
  const enterpriseSteps = options.enterprise ? [...options.enterprise] : undefined;
  const statusSteps = options.status ? [...options.status] : undefined;

  return spyOn(SonarHttpClient.prototype, 'getSafe').mockImplementation(
    <TValue>(
      endpoint: string,
      _params?: Record<string, string | number | boolean>,
      _baseUrl?: string,
    ): ResultAsync<SafeGetResult<TValue>, never> => {
      if (endpoint === '/api/users/current') {
        const step = shiftStep(userSteps, { ok: true });
        return okAsync({
          response: fakeStepResponse(step),
          value: (step.id ? { id: step.id } : {}) as TValue,
        });
      }
      if (endpoint === '/organizations/organizations') {
        const step = shiftStep(orgSteps, { ok: true });
        return okAsync({
          response: fakeStepResponse(step),
          value: (step.uuidV4
            ? [{ uuidV4: step.uuidV4, id: step.id ?? `id-${step.uuidV4}` }]
            : []) as TValue,
        });
      }
      if (endpoint === '/enterprises/enterprise-organizations') {
        const step = shiftStep(enterpriseSteps, { ok: true });
        return okAsync({
          response: fakeStepResponse(step),
          value: (step.enterpriseId ? [{ enterpriseId: step.enterpriseId }] : []) as TValue,
        });
      }
      if (endpoint === '/api/system/status') {
        const step = shiftStep(statusSteps, { ok: true });
        return okAsync({
          response: fakeStepResponse(step),
          value: {
            status: 'UP',
            version: '1',
            ...(step.id ? { id: step.id } : {}),
          } as TValue,
        });
      }
      throw new Error(`Unexpected getSafe endpoint in identity test: ${endpoint}`);
    },
  );
}
