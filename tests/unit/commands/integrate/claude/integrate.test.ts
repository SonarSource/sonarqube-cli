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

import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test';

import type { VortexDisposition } from '@/commands/integrate/_common/types.ts';
import { integrateClaude } from '@/commands/integrate/claude';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import * as token from '@/core/auth/token.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import * as registry from '@/core/framework/features';
import { okAsync } from '@/core/result.ts';
import { ScaClient } from '@/core/server/sca.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';
import { VortexEntitlementClient } from '@/core/vortex/entitlement.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';

const SERVER_AUTH = new ResolvedAuth({
  token: 'test-token',
  serverUrl: 'https://sonar.example.com',
  connectionType: 'on-premise',
  source: 'state' as const,
});

const CLOUD_AUTH = new ResolvedAuth({
  token: 'test-token',
  orgKey: 'cloud-org',
  serverUrl: 'https://sonarcloud.io',
  connectionType: 'cloud',
  source: 'state' as const,
});

let fake: FakeConsole;
let SERVER_CTX: CommandAuthenticatedInvocationContext;
let CLOUD_CTX: CommandAuthenticatedInvocationContext;

describe('integrateCommand', () => {
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let hasVortexEntitlementSpy: Mock<
    Extract<
      (typeof VortexEntitlementClient.prototype)['hasVortexEntitlement'],
      (...args: any[]) => any
    >
  >;
  let checkTokenStatusSpy: Mock<
    Extract<(typeof token)['checkTokenStatus'], (...args: any[]) => any>
  >;
  let installIntegrationSpy: Mock<
    Extract<(typeof registry)['installIntegration'], (...args: any[]) => any>
  >;
  let getScaEnablementSpy: Mock<
    Extract<(typeof ScaClient.prototype)['getScaEnablement'], (...args: any[]) => any>
  >;

  beforeEach(() => {
    fake = new FakeConsole();
    SERVER_CTX = new CommandAuthenticatedInvocationContext(SERVER_AUTH, fake);
    CLOUD_CTX = new CommandAuthenticatedInvocationContext(CLOUD_AUTH, fake);

    hasVortexEntitlementSpy = spyOn(VortexEntitlementClient.prototype, 'hasVortexEntitlement');
    hasVortexEntitlementSpy.mockResolvedValue({ status: 'not_entitled' });
    getScaEnablementSpy = spyOn(ScaClient.prototype, 'getScaEnablement').mockReturnValue(
      okAsync('not_enabled'),
    );

    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => {});

    checkTokenStatusSpy = spyOn(token, 'checkTokenStatus').mockResolvedValue({ status: 'valid' });
    installIntegrationSpy = spyOn(registry, 'installIntegration').mockResolvedValue([]);
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    hasVortexEntitlementSpy.mockRestore();
    checkTokenStatusSpy.mockRestore();
    installIntegrationSpy.mockRestore();
    getScaEnablementSpy.mockRestore();
  });

  it('shows intro message', async () => {
    await integrateClaude({}, SERVER_CTX);

    const introText = fake.calls.find(
      (c) =>
        c.method === 'intro' && String(c.args[0]) === 'SonarQube Integration Setup for Claude Code',
    );
    expect(introText).toBeDefined();
  });

  it('validates token against the auth server URL', async () => {
    await integrateClaude({}, SERVER_CTX);

    expect(checkTokenStatusSpy).toHaveBeenCalledWith(SERVER_AUTH.serverUrl, SERVER_AUTH.token);
  });

  it('validates organization is provided when server is SonarQube Cloud', async () => {
    const cloudAuthNoOrg = new ResolvedAuth({
      token: 'test-token',
      serverUrl: 'https://sonarcloud.io',
      connectionType: 'cloud',
      source: 'state' as const,
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      integrateClaude(
        {},
        new CommandAuthenticatedInvocationContext(cloudAuthNoOrg, new FakeConsole()),
      ),
    ).rejects.toThrow(CommandFailedError);
  });

  it('aborts when token is invalid', async () => {
    checkTokenStatusSpy.mockResolvedValue({ status: 'invalid' });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(integrateClaude({}, SERVER_CTX)).rejects.toThrow('Token is invalid.');
    expect(installIntegrationSpy).not.toHaveBeenCalled();
  });

  it('aborts when server is unreachable', async () => {
    checkTokenStatusSpy.mockResolvedValue({ status: 'unreachable' });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(integrateClaude({}, SERVER_CTX)).rejects.toThrow('Server is unreachable.');
    expect(installIntegrationSpy).not.toHaveBeenCalled();
  });

  it('checks Vortex entitlement', async () => {
    hasVortexEntitlementSpy.mockResolvedValue({ status: 'enabled' });

    await integrateClaude({}, CLOUD_CTX);

    expect(hasVortexEntitlementSpy).toHaveBeenCalledTimes(1);
  });

  it('installs Vortex through the declarative installer in a single call', async () => {
    mockVortexEntitlement(true);
    getScaEnablementSpy.mockReturnValue(okAsync('enabled'));

    await integrateClaude({}, CLOUD_CTX);

    expect(installIntegrationSpy).toHaveBeenCalledTimes(1);
    expect(installIntegrationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: 'claude-code',
        auth: CLOUD_AUTH,
        options: expect.objectContaining({
          vortexDisposition: 'install',
        }),
        scope: 'global',
        targetRoot: homedir(),
        attrs: {
          orgKey: 'cloud-org',
          scaEnabled: true,
          serverUrl: 'https://sonarcloud.io',
        },
      }),
    );
  });

  it('requests Vortex removal when the project organization is not entitled', async () => {
    mockVortexEntitlement(false);

    await integrateClaude({}, CLOUD_CTX);

    expectClaudeInstallCall({
      targetRoot: homedir(),
      scope: 'global',
      auth: CLOUD_AUTH,
      vortexDisposition: 'remove',
    });
  });

  it('rethrows Vortex installation failures', async () => {
    mockVortexEntitlement(true);
    installIntegrationSpy.mockRejectedValueOnce(new Error('print failed'));

    let thrown: unknown;
    try {
      await integrateClaude({}, CLOUD_CTX);
    } catch (error) {
      thrown = error;
    }

    if (!(thrown instanceof Error)) {
      throw new Error('Expected integrateClaude to reject');
    }
    expect(thrown.message).toBe('print failed');

    expect(installIntegrationSpy).toHaveBeenCalledTimes(1);
  });

  it('runs migration and installs hooks when setup summary succeeds', async () => {
    mockVortexEntitlement(true);

    await integrateClaude({}, CLOUD_CTX);

    assertMigrationAndHookInstallationRan('install');
  });

  it('aborts integration when sonar-secrets installation fails', async () => {
    installIntegrationSpy.mockRejectedValueOnce(new Error('Network error'));

    let error: unknown;
    try {
      await integrateClaude({}, SERVER_CTX);
    } catch (err) {
      error = err;
    }

    expect((error as Error).message).toBe('Network error');
    expect(installIntegrationSpy).toHaveBeenCalledTimes(1);
  });

  function mockVortexEntitlement(hasEntitlement: boolean) {
    hasVortexEntitlementSpy.mockResolvedValue({
      status: hasEntitlement ? 'enabled' : 'not_entitled',
    });
  }

  function assertMigrationAndHookInstallationRan(
    vortexDisposition: VortexDisposition,
    auth: ResolvedAuth = CLOUD_AUTH,
  ): void {
    expectClaudeInstallCall({
      targetRoot: homedir(),
      scope: 'global',
      auth,
      vortexDisposition,
    });
  }

  function expectClaudeInstallCall({
    targetRoot,
    scope,
    auth,
    vortexDisposition,
  }: {
    targetRoot: string;
    scope: 'global';
    auth: ResolvedAuth;
    vortexDisposition: VortexDisposition;
  }): void {
    // The connection attrs are recorded only when Vortex is installed: its
    // context augmentation subfeature reads them back at runtime.
    const attrs = {
      ...(vortexDisposition === 'install'
        ? { orgKey: auth.orgKey ?? null, scaEnabled: false, serverUrl: auth.serverUrl }
        : {}),
    };

    expect(installIntegrationSpy).toHaveBeenCalledTimes(1);
    expect(installIntegrationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: 'claude-code',
        auth,
        options: expect.objectContaining({ vortexDisposition }),
        scope,
        targetRoot,
        attrs,
      }),
    );
  }
});
