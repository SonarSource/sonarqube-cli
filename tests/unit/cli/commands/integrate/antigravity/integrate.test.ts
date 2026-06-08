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

import * as token from '../../../../../../src/cli/commands/_common/token';
import * as contextAugmentation from '../../../../../../src/cli/commands/integrate/_common/context-augmentation';
import * as registry from '../../../../../../src/cli/commands/integrate/_common/registry';
import { integrateAntigravity } from '../../../../../../src/cli/commands/integrate/antigravity';
import { ANTIGRAVITY_INTEGRATION_ID } from '../../../../../../src/cli/commands/integrate/antigravity/declaration';
import type { ResolvedAuth } from '../../../../../../src/lib/auth-resolver';
import { ANTIGRAVITY_GLOBAL_CONFIG_DIR } from '../../../../../../src/lib/config-constants';
import type { DiscoveredProject } from '../../../../../../src/lib/project-workspace';
import * as discovery from '../../../../../../src/lib/project-workspace';
import { SonarQubeClient } from '../../../../../../src/sonarqube/client';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../../../src/ui';

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

describe('integrateAntigravity', () => {
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
    checkTokenStatusSpy = spyOn(token, 'checkTokenStatus').mockResolvedValue('valid');
    discoverProjectSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(BASE_PROJECT);
    installIntegrationSpy = spyOn(registry, 'installIntegration').mockResolvedValue([]);
    hasSqaaEntitlementSpy = spyOn(
      SonarQubeClient.prototype,
      'hasSqaaEntitlement',
    ).mockResolvedValue(false);
    checkComponentSpy = spyOn(SonarQubeClient.prototype, 'checkComponent').mockResolvedValue(true);
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
    resolveContextAugmentationSetupSpy.mockRestore();
  });

  it('aborts when token is invalid', () => {
    checkTokenStatusSpy.mockResolvedValue('invalid');

    expect(integrateAntigravity({}, SERVER_AUTH)).rejects.toThrow('Token is invalid.');
    expect(installIntegrationSpy).not.toHaveBeenCalled();
  });

  it('delegates to installIntegration with connection metadata attrs', async () => {
    await integrateAntigravity({ nonInteractive: true }, SERVER_AUTH);

    expect(installIntegrationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: ANTIGRAVITY_INTEGRATION_ID,
        targetRoot: BASE_PROJECT.rootDir,
        scope: 'project',
        attrs: {
          projectKey: BASE_PROJECT.projectKey,
          serverUrl: SERVER_AUTH.serverUrl,
          orgKey: null,
        },
      }),
    );
  });

  it('uses the global Antigravity config directory for --global installs', async () => {
    await integrateAntigravity({ global: true, nonInteractive: true }, SERVER_AUTH);

    expect(installIntegrationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        targetRoot: ANTIGRAVITY_GLOBAL_CONFIG_DIR,
        scope: 'global',
      }),
    );
  });

  it('announces Context Augmentation skip for --skip-context', async () => {
    await integrateAntigravity({ skipContext: true, nonInteractive: true }, SERVER_AUTH);

    expect(resolveContextAugmentationSetupSpy).not.toHaveBeenCalled();
    const infoCalls = getMockUiCalls().filter((call) => call.method === 'info');
    expect(infoCalls.some((call) => String(call.args[0]).includes('--skip-context'))).toBe(true);
  });

  it('passes installContextAugmentation when CAG setup resolves', async () => {
    resolveContextAugmentationSetupSpy.mockResolvedValue({ scaEnabled: true });

    await integrateAntigravity({ nonInteractive: true }, SERVER_AUTH);

    expect(installIntegrationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ installContextAugmentation: true }),
        attrs: expect.objectContaining({ scaEnabled: true }),
      }),
    );
  });
});
