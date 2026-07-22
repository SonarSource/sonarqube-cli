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

import { clearMockUiCalls, setMockUi } from '@/core/ui';

import * as token from '../../../../../src/commands/_common/token.ts';
import * as contextAugmentation from '../../../../../src/commands/integrate/_common/context-augmentation.ts';
import * as registry from '../../../../../src/commands/integrate/_common/registry';
import { integrateCopilot } from '../../../../../src/commands/integrate/copilot';
import * as hooks from '../../../../../src/commands/integrate/copilot/hooks.ts';
import type { ResolvedAuth } from '../../../../../src/lib/auth-resolver.ts';
import type { DiscoveredProject } from '../../../../../src/lib/project-workspace';
import * as discovery from '../../../../../src/lib/project-workspace';
import { SonarQubeClient } from '../../../../../src/sonarqube/client.ts';

const SERVER_AUTH: ResolvedAuth = {
  token: 'test-token',
  serverUrl: 'https://sonar.example.com',
  connectionType: 'on-premise',
};

const BASE_PROJECT: DiscoveredProject = {
  rootDir: '/project/root',
  isGitRepo: true,
  configSources: [],
  projectKey: 'my-project',
};

describe('integrateCopilot', () => {
  let checkTokenStatusSpy: Mock<
    Extract<(typeof token)['checkTokenStatus'], (...args: never[]) => unknown>
  >;
  let discoverProjectSpy: Mock<
    Extract<(typeof discovery)['discoverProject'], (...args: never[]) => unknown>
  >;
  let installIntegrationSpy: Mock<
    Extract<(typeof registry)['installIntegration'], (...args: never[]) => unknown>
  >;
  let hasSqaaEntitlementSpy: Mock<
    Extract<(typeof SonarQubeClient.prototype)['hasSqaaEntitlement'], (...args: never[]) => unknown>
  >;
  let detectGlobalSecretsHookSpy: Mock<
    Extract<(typeof hooks)['detectGlobalSecretsHook'], (...args: never[]) => unknown>
  >;
  let checkComponentSpy: Mock<
    Extract<(typeof SonarQubeClient.prototype)['checkComponent'], (...args: never[]) => unknown>
  >;
  let resolveContextAugmentationSetupSpy: Mock<
    Extract<
      (typeof contextAugmentation)['resolveContextAugmentationSetup'],
      (...args: never[]) => unknown
    >
  >;

  beforeEach(() => {
    setMockUi(true);
    checkTokenStatusSpy = spyOn(token, 'checkTokenStatus').mockResolvedValue({ status: 'valid' });
    discoverProjectSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(BASE_PROJECT);
    installIntegrationSpy = spyOn(registry, 'installIntegration').mockResolvedValue([]);
    hasSqaaEntitlementSpy = spyOn(
      SonarQubeClient.prototype,
      'hasSqaaEntitlement',
    ).mockResolvedValue('not_enabled');
    checkComponentSpy = spyOn(SonarQubeClient.prototype, 'checkComponent').mockResolvedValue(true);
    detectGlobalSecretsHookSpy = spyOn(hooks, 'detectGlobalSecretsHook').mockResolvedValue(
      undefined,
    );
    resolveContextAugmentationSetupSpy = spyOn(
      contextAugmentation,
      'resolveContextAugmentationSetup',
    ).mockResolvedValue(null);
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    checkTokenStatusSpy.mockRestore();
    discoverProjectSpy.mockRestore();
    installIntegrationSpy.mockRestore();
    hasSqaaEntitlementSpy.mockRestore();
    checkComponentSpy.mockRestore();
    detectGlobalSecretsHookSpy.mockRestore();
    resolveContextAugmentationSetupSpy.mockRestore();
  });

  it('aborts when token is invalid', () => {
    checkTokenStatusSpy.mockResolvedValue({ status: 'invalid' });

    expect(integrateCopilot({}, SERVER_AUTH)).rejects.toThrow('Token is invalid.');
    expect(installIntegrationSpy).not.toHaveBeenCalled();
  });

  it('aborts when server is unreachable', () => {
    checkTokenStatusSpy.mockResolvedValue({ status: 'unreachable' });

    expect(integrateCopilot({}, SERVER_AUTH)).rejects.toThrow('Server is unreachable.');
    expect(installIntegrationSpy).not.toHaveBeenCalled();
  });

  it('validates token against the auth server URL before installing', async () => {
    await integrateCopilot({}, SERVER_AUTH);

    expect(checkTokenStatusSpy).toHaveBeenCalledWith(SERVER_AUTH.serverUrl, SERVER_AUTH.token);
  });
});
