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

import { SonarQubeClient } from '@/core/server/client.ts';

interface ApiStep {
  ok: boolean;
  id?: string;
  /** When true, getSafe() itself throws (network error/timeout) instead of resolving. */
  throws?: boolean;
}

interface ProjectUuidApiMockOptions {
  component?: ApiStep[];
}

function shiftStep(queue: ApiStep[] | undefined, fallback: ApiStep): ApiStep {
  return queue?.shift() ?? fallback;
}

/** Mock SonarQubeClient.getSafe for telemetry project-uuid resolver tests. */
export function mockProjectUuidGetSafe(
  options: ProjectUuidApiMockOptions = {},
): ReturnType<typeof spyOn> {
  const prototype = SonarQubeClient.prototype as {
    getSafe?: ReturnType<typeof spyOn>;
  };
  prototype.getSafe?.mockRestore?.();

  const componentSteps = options.component ? [...options.component] : undefined;

  return spyOn(SonarQubeClient.prototype, 'getSafe').mockImplementation(
    <TValue>(
      endpoint: string,
      _params?: Record<string, string | number | boolean>,
      _baseUrl?: string,
    ): Promise<{ response: Response; value: TValue | undefined }> => {
      if (endpoint === '/api/navigation/component') {
        const step = shiftStep(componentSteps, { ok: true });
        if (step.throws) {
          return Promise.reject(new Error('network error'));
        }
        return Promise.resolve({
          response: { ok: step.ok } as Response,
          value: (step.id ? { id: step.id } : {}) as TValue,
        });
      }
      return Promise.reject(
        new Error(`Unexpected getSafe endpoint in project-uuid test: ${endpoint}`),
      );
    },
  );
}
