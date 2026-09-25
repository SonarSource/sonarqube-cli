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

import { afterEach, describe, expect, it } from 'bun:test';

import { authLogin } from '@/commands/auth/login.ts';
import { ENV_ORG, ENV_SERVER, ENV_TOKEN } from '@/core/auth/auth-resolver.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { SONARCLOUD_URL } from '@/core/config-constants.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

const originalIsTTY = process.stdin.isTTY;
const originalEnv = {
  token: process.env[ENV_TOKEN],
  server: process.env[ENV_SERVER],
  org: process.env[ENV_ORG],
};

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', {
    value: originalIsTTY,
    configurable: true,
  });
  for (const [key, value] of [
    [ENV_TOKEN, originalEnv.token],
    [ENV_SERVER, originalEnv.server],
    [ENV_ORG, originalEnv.org],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function login(options: Parameters<typeof authLogin>[0]): Promise<void> {
  return authLogin(options, new CommandInvocationContext(new FakeConsole()));
}

async function expectLoginFailure(
  options: Parameters<typeof authLogin>[0],
  message: string,
): Promise<void> {
  let error: unknown;
  try {
    await login(options);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

describe('auth login --with-token option validation', () => {
  it('requires an explicit server', async () => {
    await expectLoginFailure({ withToken: true }, '--server is required with --with-token.');
  });

  it.each(['not-a-url', 'ftp://sonarqube.example.com', 'https://sonarqube.example.com\ninvalid'])(
    'rejects an invalid server URL',
    async (serverUrl) => {
      await expectLoginFailure(
        { server: serverUrl },
        'Invalid server URL. It must be an absolute HTTP(S) URL with a host and no control characters.',
      );
    },
  );

  it('requires an explicit organization for SonarQube Cloud', async () => {
    await expectLoginFailure(
      { withToken: true, server: SONARCLOUD_URL },
      '--org is required for SonarQube Cloud with --with-token.',
    );
  });

  it('rejects terminal input with a redirection hint', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    await expectLoginFailure(
      { withToken: true, server: 'https://sonarqube.example.com' },
      '--with-token reads a token from standard input.',
    );
  });

  it.each([ENV_SERVER, ENV_ORG])(
    'refuses to save a token while environment authentication uses %s',
    async (targetVariable) => {
      process.env[ENV_TOKEN] = 'environment-token';
      process.env[targetVariable] =
        targetVariable === ENV_SERVER ? 'https://sonarqube.example.com' : 'environment-org';

      await expectLoginFailure(
        { withToken: true, server: 'https://sonarqube.example.com' },
        'Environment variable authentication is already active.',
      );
    },
  );
});
