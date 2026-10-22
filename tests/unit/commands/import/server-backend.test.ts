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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { ServerImportApiClient } from '@/commands/import/server/server-import-api.ts';
import { ServerBackend } from '@/commands/import/server-backend.ts';
import { ENV_IMPORT_PAT_POLL_INTERVAL_MS } from '@/core/config-constants.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

const GITLAB = { id: 'gl-id', key: 'my-gitlab', type: 'gitlab', url: 'https://gitlab.example.com' };

const MANAGED_ENV = [
  'CI',
  'SONARQUBE_CLI_MOCK_TTY',
  'SONARQUBE_CLI_DISABLE_BROWSER',
  ENV_IMPORT_PAT_POLL_INTERVAL_MS,
] as const;

describe('ServerBackend PAT wait', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of MANAGED_ENV) {
      saved.set(name, process.env[name]);
    }
    process.env.CI = 'false';
    process.env.SONARQUBE_CLI_MOCK_TTY = '1';
    process.env.SONARQUBE_CLI_DISABLE_BROWSER = 'true';
    process.env[ENV_IMPORT_PAT_POLL_INTERVAL_MS] = '20';
  });

  afterEach(() => {
    for (const name of MANAGED_ENV) {
      const value = saved.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('stops waiting on SIGINT, fails with the connect URL and removes its listener', async () => {
    const listenersBefore = process.listenerCount('SIGINT');
    let checks = 0;
    const api = {
      listDopSettings: () => Promise.resolve([GITLAB]),
      checkPat: () => {
        checks++;
        return Promise.resolve('missing');
      },
    } as unknown as ServerImportApiClient;
    const backend = new ServerBackend(api, 'https://sonar.example.com');

    const planning = backend.plan({ all: true }, new FakeConsole());
    const settled = planning.then(
      () => undefined,
      (error: unknown) => error,
    );
    while (checks < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    process.emit('SIGINT');

    expect(await settled).toMatchObject({
      message: expect.stringContaining('Stopped waiting.'),
      remediationHint: expect.stringContaining('https://sonar.example.com/projects/create?'),
    });
    expect(process.listenerCount('SIGINT')).toBe(listenersBefore);
  });
});
