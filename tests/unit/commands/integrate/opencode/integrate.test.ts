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

import { homedir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from 'bun:test';

import * as vortex from '@/commands/integrate/_common/vortex.ts';
import { integrateOpenCode } from '@/commands/integrate/opencode';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import * as token from '@/core/auth/token.ts';
import { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import * as registry from '@/core/framework/features';

import { FakeConsole } from '../../../../_common/fake-console.ts';

const SERVER_AUTH = new ResolvedAuth({
  token: 'test-token',
  serverUrl: 'https://sonar.example.com',
  connectionType: 'on-premise',
  source: 'state' as const,
});

let SERVER_CTX: CommandAuthenticatedInvocationContext;

let fake: FakeConsole;

beforeEach(() => {
  fake = new FakeConsole();
  SERVER_CTX = new CommandAuthenticatedInvocationContext(SERVER_AUTH, fake);
});

describe('integrateOpenCode', () => {
  let checkTokenStatusSpy: Mock<
    Extract<(typeof token)['checkTokenStatus'], (...args: never[]) => unknown>
  >;
  let installIntegrationSpy: Mock<
    Extract<(typeof registry)['installIntegration'], (...args: never[]) => unknown>
  >;
  let resolveVortexSetupSpy: Mock<
    Extract<(typeof vortex)['resolveVortexSetup'], (...args: never[]) => unknown>
  >;

  beforeEach(() => {
    checkTokenStatusSpy = spyOn(token, 'checkTokenStatus').mockResolvedValue({ status: 'valid' });
    installIntegrationSpy = spyOn(registry, 'installIntegration').mockResolvedValue([]);
    resolveVortexSetupSpy = spyOn(vortex, 'resolveVortexSetup').mockResolvedValue({
      disposition: 'preserve',
    });
  });

  afterEach(() => {
    checkTokenStatusSpy.mockRestore();
    installIntegrationSpy.mockRestore();
    resolveVortexSetupSpy.mockRestore();
  });

  it('aborts when token is invalid', async () => {
    checkTokenStatusSpy.mockResolvedValue({ status: 'invalid' });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(integrateOpenCode({}, SERVER_CTX)).rejects.toThrow('Token is invalid.');
    expect(installIntegrationSpy).not.toHaveBeenCalled();
  });

  it('aborts when server is unreachable', async () => {
    checkTokenStatusSpy.mockResolvedValue({ status: 'unreachable' });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(integrateOpenCode({}, SERVER_CTX)).rejects.toThrow('Server is unreachable.');
    expect(installIntegrationSpy).not.toHaveBeenCalled();
  });

  it('validates token against the auth server URL before installing', async () => {
    await integrateOpenCode({}, SERVER_CTX);

    expect(checkTokenStatusSpy).toHaveBeenCalledWith(SERVER_AUTH.serverUrl, SERVER_AUTH.token);
  });

  it('installs through the declarative installer, always globally', async () => {
    await integrateOpenCode({}, SERVER_CTX);

    expect(installIntegrationSpy).toHaveBeenCalledTimes(1);
    expect(installIntegrationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: 'opencode',
        auth: SERVER_AUTH,
        scope: 'global',
        targetRoot: homedir(),
      }),
    );
  });
});
