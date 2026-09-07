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

import { createServer } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { assertTokenCheckSucceeded, generateTokenViaBrowser } from '@/core/auth/token.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { SONARCLOUD_URL } from '@/core/config-constants.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

const LOOPBACK_PREFIX = 'http://127.0.0.1:';
const UNREACHABLE_SERVER = 'http://127.0.0.1:1';

function portFromAuthUrl(url: string): number {
  return Number(new URL(url).searchParams.get('port'));
}

async function postCallback(port: number, token: string): Promise<Response> {
  return fetch(`${LOOPBACK_PREFIX}${port}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

function startFakeSonar(validate: { valid?: boolean; status?: number }): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const path = req.url ?? '';
      if (path.startsWith('/api/system/status')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'UP', version: '2026.3.0' }));
        return;
      }
      if (path.startsWith('/api/authentication/validate')) {
        res.writeHead(validate.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ valid: validate.valid ?? false }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to bind fake SonarQube server'));
        return;
      }
      resolve({
        url: `${LOOPBACK_PREFIX}${address.port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

describe('assertTokenCheckSucceeded', () => {
  it('returns when the token is valid', () => {
    expect(() => assertTokenCheckSucceeded({ status: 'valid' }, SONARCLOUD_URL)).not.toThrow();
  });

  it('reports an unreachable server instead of blaming the token', () => {
    try {
      assertTokenCheckSucceeded(
        { status: 'unreachable', errorMessage: 'ECONNREFUSED' },
        SONARCLOUD_URL,
      );
      expect.unreachable('expected CommandFailedError');
    } catch (err) {
      expect(err).toBeInstanceOf(CommandFailedError);
      expect((err as CommandFailedError).message).toBe(
        `Could not reach ${SONARCLOUD_URL} to validate the token: ECONNREFUSED`,
      );
      expect((err as CommandFailedError).remediationHint).toBe(
        'Check your network connection and the server status, then rerun the command.',
      );
    }
  });

  it('uses a fallback when the unreachable check has no error message', () => {
    expect(() => assertTokenCheckSucceeded({ status: 'unreachable' }, SONARCLOUD_URL)).toThrow(
      `Could not reach ${SONARCLOUD_URL} to validate the token: unknown error`,
    );
  });

  it('reports a rejected token with a remediation hint', () => {
    try {
      assertTokenCheckSucceeded({ status: 'invalid' }, SONARCLOUD_URL);
      expect.unreachable('expected CommandFailedError');
    } catch (err) {
      expect(err).toBeInstanceOf(CommandFailedError);
      expect((err as CommandFailedError).message).toBe(
        'The provided token was rejected by the SonarQube server.',
      );
      expect((err as CommandFailedError).remediationHint).toBe(
        'Generate a new user token and try again.',
      );
    }
  });
});

describe('generateTokenViaBrowser', () => {
  let savedCi: string | undefined;
  let fakeSonar: { url: string; close: () => Promise<void> } | undefined;

  beforeEach(() => {
    savedCi = process.env.CI;
    process.env.CI = 'true';
  });

  afterEach(async () => {
    await fakeSonar?.close();
    fakeSonar = undefined;
    if (savedCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = savedCi;
    }
  });

  it(
    'fails fast in CI when the callback token is invalid',
    async () => {
      fakeSonar = await startFakeSonar({ valid: false });
      const console = new FakeConsole();

      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
      await expect(
        generateTokenViaBrowser(fakeSonar.url, console, async (authUrl) => {
          const response = await postCallback(portFromAuthUrl(authUrl), 'bad-token');
          expect(response.status).toBe(401);
        }),
      ).rejects.toThrow('The token delivered by the browser could not be validated.');
    },
    { timeout: 10_000 },
  );

  it(
    'fails fast in CI when token validation cannot reach the server',
    async () => {
      const console = new FakeConsole();

      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
      await expect(
        generateTokenViaBrowser(UNREACHABLE_SERVER, console, async (authUrl) => {
          const response = await postCallback(portFromAuthUrl(authUrl), 'any-token');
          expect(response.status).toBe(401);
        }),
      ).rejects.toThrow('The token delivered by the browser could not be validated.');
    },
    { timeout: 10_000 },
  );

  it(
    'resolves in CI when the callback token is valid',
    async () => {
      fakeSonar = await startFakeSonar({ valid: true });
      const console = new FakeConsole();

      const result = await generateTokenViaBrowser(fakeSonar.url, console, async (authUrl) => {
        const response = await postCallback(portFromAuthUrl(authUrl), 'good-token');
        expect(response.status).toBe(200);
      });

      expect(result.token).toBe('good-token');
    },
    { timeout: 10_000 },
  );
});
