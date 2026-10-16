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

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type {
  PatProbe,
  ServerImportApiClient,
} from '@/commands/import/server/server-import-api.ts';
import { ServerBackend } from '@/commands/import/server-backend.ts';
import { ENV_IMPORT_PAT_POLL_INTERVAL_MS } from '@/core/config-constants.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';

const SERVER_URL = 'https://sonarqube.example.com';
const GITHUB = { id: 'gh-id', key: 'my-github', type: 'github' as const };
const CONNECT_URL = `${SERVER_URL}/projects/create?mode=github&dopSetting=gh-id`;

/** The probe answers `probes` in order; the last one repeats. */
function backendWith(probes: PatProbe[]) {
  let call = 0;
  const probeGithubPat = mock(() => Promise.resolve(probes[Math.min(call++, probes.length - 1)]));
  const listGithubOrganizations = mock(() =>
    Promise.resolve({ organizations: [{ key: 'acme' }], total: 1 }),
  );
  const listGithubRepositories = mock(() =>
    Promise.resolve({ repositories: [{ id: 1, key: 'acme/api', name: 'api' }], total: 1 }),
  );
  const api = {
    listDopSettings: () => Promise.resolve([GITHUB]),
    probeGithubPat,
    listGithubOrganizations,
    listGithubRepositories,
  } as unknown as ServerImportApiClient;
  return { backend: new ServerBackend(api, SERVER_URL), probeGithubPat, listGithubOrganizations };
}

const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('ServerBackend GitHub token gate', () => {
  it('fails with the connect URL when GitHub lists no organizations for a valid probe', async () => {
    const { backend, listGithubOrganizations } = backendWith([
      { status: 'valid', organizationCount: 0 },
    ]);

    const error = await failureOf(
      backend.plan({ all: true, nonInteractive: true }, new FakeConsole()),
    );

    const { message, remediationHint } = error as { message: string; remediationHint: string };
    expect(message).toContain('GitHub returned no organizations');
    expect(message).toContain('expired or revoked');
    expect(message).toContain('GitHub App');
    expect(remediationHint).toContain(CONNECT_URL);
    expect(remediationHint).not.toContain('resetPat');
    expect(listGithubOrganizations).not.toHaveBeenCalled();
  });

  it('proceeds to list repositories when the probe found organizations', async () => {
    const { backend, probeGithubPat } = backendWith([{ status: 'valid', organizationCount: 2 }]);

    const plan = await backend.plan({ all: true, nonInteractive: true }, new FakeConsole());

    expect(plan.selection.kind).toBe('streaming');
    expect(probeGithubPat).toHaveBeenCalledTimes(1);
  });

  it('proceeds when the probe response carried no listing to count', async () => {
    const { backend } = backendWith([{ status: 'valid' }]);

    const plan = await backend.plan({ all: true, nonInteractive: true }, new FakeConsole());

    expect(plan.selection.kind).toBe('streaming');
  });

  it('still reports a missing token with the connect URL', async () => {
    const { backend } = backendWith([{ status: 'missing' }]);

    const error = await failureOf(
      backend.plan({ all: true, nonInteractive: true }, new FakeConsole()),
    );

    expect(error).toMatchObject({
      message: expect.stringContaining('No personal access token is connected'),
      remediationHint: expect.stringContaining(CONNECT_URL),
    });
  });

  describe('while waiting for the token to be connected', () => {
    const MANAGED_ENV = [
      'CI',
      'SONARQUBE_CLI_MOCK_TTY',
      'SONARQUBE_CLI_DISABLE_BROWSER',
      ENV_IMPORT_PAT_POLL_INTERVAL_MS,
    ] as const;
    const saved = new Map<string, string | undefined>();

    beforeEach(() => {
      for (const name of MANAGED_ENV) {
        saved.set(name, process.env[name]);
      }
      process.env.CI = 'false';
      process.env.SONARQUBE_CLI_MOCK_TTY = '1';
      process.env.SONARQUBE_CLI_DISABLE_BROWSER = 'true';
      process.env[ENV_IMPORT_PAT_POLL_INTERVAL_MS] = '10';
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

    it('continues when the connected token lists organizations', async () => {
      const { backend } = backendWith([
        { status: 'missing' },
        { status: 'valid', organizationCount: 1 },
      ]);

      const plan = await backend.plan({ all: true }, new FakeConsole());

      expect(plan.selection.kind).toBe('streaming');
    });

    it('fails with the connect URL when the connected token lists no organizations', async () => {
      const { backend } = backendWith([
        { status: 'missing' },
        { status: 'valid', organizationCount: 0 },
      ]);

      const error = await failureOf(backend.plan({ all: true }, new FakeConsole()));

      expect(error).toMatchObject({
        message: expect.stringContaining('GitHub returned no organizations'),
        remediationHint: expect.stringContaining(CONNECT_URL),
      });
    });
  });
});
