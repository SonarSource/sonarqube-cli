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

import { SonarQubeClient } from '@/sonarqube/client.ts';

interface ApiStep {
  ok: boolean;
  id?: string;
  uuidV4?: string;
}

interface IdentityApiMockOptions {
  user?: ApiStep[];
  org?: ApiStep[];
  status?: ApiStep[];
}

function shiftStep(queue: ApiStep[] | undefined, fallback: ApiStep): ApiStep {
  return queue?.shift() ?? fallback;
}

/** Mock SonarQubeClient.getSafe for telemetry identity resolver tests. */
export function mockIdentityGetSafe(
  options: IdentityApiMockOptions = {},
): ReturnType<typeof spyOn> {
  const prototype = SonarQubeClient.prototype as {
    getSafe?: ReturnType<typeof spyOn>;
  };
  prototype.getSafe?.mockRestore?.();

  const userSteps = options.user ? [...options.user] : undefined;
  const orgSteps = options.org ? [...options.org] : undefined;
  const statusSteps = options.status ? [...options.status] : undefined;

  return spyOn(SonarQubeClient.prototype, 'getSafe').mockImplementation(
    <TValue>(
      endpoint: string,
      _params?: Record<string, string | number | boolean>,
      _baseUrl?: string,
    ): Promise<{ response: Response; value: TValue | undefined }> => {
      if (endpoint === '/api/users/current') {
        const step = shiftStep(userSteps, { ok: true });
        return Promise.resolve({
          response: { ok: step.ok } as Response,
          value: (step.id ? { id: step.id } : {}) as TValue,
        });
      }
      if (endpoint === '/organizations/organizations') {
        const step = shiftStep(orgSteps, { ok: true });
        return Promise.resolve({
          response: { ok: step.ok } as Response,
          value: (step.uuidV4 ? [{ uuidV4: step.uuidV4 }] : []) as TValue,
        });
      }
      if (endpoint === '/api/system/status') {
        const step = shiftStep(statusSteps, { ok: true });
        return Promise.resolve({
          response: { ok: step.ok } as Response,
          value: {
            status: 'UP',
            version: '1',
            ...(step.id ? { id: step.id } : {}),
          } as TValue,
        });
      }
      return Promise.reject(new Error(`Unexpected getSafe endpoint in identity test: ${endpoint}`));
    },
  );
}
