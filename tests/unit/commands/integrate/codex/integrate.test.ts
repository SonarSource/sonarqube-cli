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

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from 'bun:test';

import * as vortex from '@/commands/integrate/_common/vortex.ts';
import { integrateCodex } from '@/commands/integrate/codex';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import * as token from '@/core/auth/token.ts';
import { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import * as registry from '@/core/framework/features';
import type { DiscoveredProject } from '@/core/project-info.ts';
import * as discovery from '@/core/project-info.ts';
import { ComponentsClient } from '@/core/server/components.ts';
import { clearMockUiCalls, setMockUi } from '@/core/ui';
import { VortexEntitlementClient } from '@/core/vortex/entitlement.ts';

const SERVER_AUTH: ResolvedAuth = {
  token: 'test-token',
  serverUrl: 'https://sonar.example.com',
  connectionType: 'on-premise',
};

const SERVER_CTX = new CommandAuthenticatedInvocationContext(SERVER_AUTH);

const BASE_PROJECT: DiscoveredProject = {
  repoRoot: '/project/root',
  projectRoot: '/project/root',
  configSources: [],
  projectKey: 'my-project',
};

describe('integrateCodex', () => {
  let checkTokenStatusSpy: Mock<
    Extract<(typeof token)['checkTokenStatus'], (...args: never[]) => unknown>
  >;
  let discoverProjectSpy: Mock<
    Extract<(typeof discovery)['discoverProject'], (...args: never[]) => unknown>
  >;
  let installIntegrationSpy: Mock<
    Extract<(typeof registry)['installIntegration'], (...args: never[]) => unknown>
  >;
  let hasVortexEntitlementSpy: Mock<
    Extract<
      (typeof VortexEntitlementClient.prototype)['hasVortexEntitlement'],
      (...args: never[]) => unknown
    >
  >;
  let checkComponentSpy: Mock<
    Extract<(typeof ComponentsClient.prototype)['checkComponent'], (...args: never[]) => unknown>
  >;
  let resolveVortexSetupSpy: Mock<
    Extract<(typeof vortex)['resolveVortexSetup'], (...args: never[]) => unknown>
  >;

  beforeEach(() => {
    setMockUi(true);
    checkTokenStatusSpy = spyOn(token, 'checkTokenStatus').mockResolvedValue({ status: 'valid' });
    discoverProjectSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(BASE_PROJECT);
    installIntegrationSpy = spyOn(registry, 'installIntegration').mockResolvedValue([]);
    hasVortexEntitlementSpy = spyOn(
      VortexEntitlementClient.prototype,
      'hasVortexEntitlement',
    ).mockResolvedValue({ status: 'not_entitled' });
    checkComponentSpy = spyOn(ComponentsClient.prototype, 'checkComponent').mockResolvedValue(true);
    resolveVortexSetupSpy = spyOn(vortex, 'resolveVortexSetup').mockResolvedValue({
      disposition: 'preserve',
    });
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    checkTokenStatusSpy.mockRestore();
    discoverProjectSpy.mockRestore();
    installIntegrationSpy.mockRestore();
    hasVortexEntitlementSpy.mockRestore();
    checkComponentSpy.mockRestore();
    resolveVortexSetupSpy.mockRestore();
  });

  it('aborts when token is invalid', async () => {
    checkTokenStatusSpy.mockResolvedValue({ status: 'invalid' });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(integrateCodex({}, SERVER_CTX)).rejects.toThrow('Token is invalid.');
    expect(installIntegrationSpy).not.toHaveBeenCalled();
  });

  it('aborts when server is unreachable', async () => {
    checkTokenStatusSpy.mockResolvedValue({ status: 'unreachable' });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(integrateCodex({}, SERVER_CTX)).rejects.toThrow('Server is unreachable.');
    expect(installIntegrationSpy).not.toHaveBeenCalled();
  });

  it('validates token against the auth server URL before installing', async () => {
    await integrateCodex({}, SERVER_CTX);

    expect(checkTokenStatusSpy).toHaveBeenCalledWith(SERVER_AUTH.serverUrl, SERVER_AUTH.token);
  });
});
