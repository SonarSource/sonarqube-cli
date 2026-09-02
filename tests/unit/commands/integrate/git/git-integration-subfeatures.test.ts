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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { SonarQubeClient } from '@/core/server/client.ts';

import type { IntegrateGitOptions } from '../../../../../src/commands/integrate/git/options.ts';
import {
  createDepRisksSubfeature,
  createSecretsSubfeature,
} from '../../../../../src/commands/integrate/git/tools/git-integration-subfeatures.ts';

type PartialInvocation = {
  options?: Partial<IntegrateGitOptions>;
  nonInteractive?: boolean;
  scope?: 'project' | 'global';
  auth?: ResolvedAuth;
};

function makeInvocation({
  options = {},
  nonInteractive = false,
  scope = 'project',
  auth,
}: PartialInvocation = {}) {
  return {
    options,
    nonInteractive,
    scope,
    auth,
    targetRoot: '/tmp',
    state: {} as never,
  };
}

const CLOUD_AUTH: ResolvedAuth = {
  serverUrl: 'https://sonarcloud.io',
  token: 'test-token',
  connectionType: 'cloud',
  orgKey: 'my-org',
};

describe('createSecretsSubfeature', () => {
  it('always installs with an explanatory message', () => {
    const sub = createSecretsSubfeature();
    expect(sub.shouldInstall!(makeInvocation())).toMatchObject({
      action: 'install',
      message: 'Secrets scan is required for other hook types and is enabled by default',
    });
  });
});

describe('createDepRisksSubfeature', () => {
  describe('with auth', () => {
    let checkScaEnabledSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      checkScaEnabledSpy = spyOn(SonarQubeClient.prototype, 'checkScaEnabled');
    });

    afterEach(() => {
      checkScaEnabledSpy.mockRestore();
    });

    it('skips with SCA unavailability message when SCA is not enabled on the connection', async () => {
      checkScaEnabledSpy.mockResolvedValue(false);
      const sub = createDepRisksSubfeature();
      expect(
        await sub.shouldInstall!(
          makeInvocation({ options: { project: 'my-project' }, auth: CLOUD_AUTH }),
        ),
      ).toMatchObject({
        action: 'skip',
        message: 'Software Composition Analysis is not available for the current connection.',
      });
    });

    it('installs when a project key is set', async () => {
      checkScaEnabledSpy.mockResolvedValue(true);
      const sub = createDepRisksSubfeature();
      expect(
        await sub.shouldInstall!(
          makeInvocation({ options: { project: 'my-project' }, auth: CLOUD_AUTH }),
        ),
      ).toMatchObject({ action: 'install' });
    });

    it('installs in non-interactive mode', async () => {
      checkScaEnabledSpy.mockResolvedValue(true);
      const sub = createDepRisksSubfeature();
      expect(
        await sub.shouldInstall!(
          makeInvocation({
            options: { project: 'my-project' },
            nonInteractive: true,
            auth: CLOUD_AUTH,
          }),
        ),
      ).toMatchObject({ action: 'install' });
    });

    it('installs for project scope without a project key (project-agnostic)', async () => {
      checkScaEnabledSpy.mockResolvedValue(true);
      const sub = createDepRisksSubfeature();
      expect(await sub.shouldInstall!(makeInvocation({ auth: CLOUD_AUTH }))).toMatchObject({
        action: 'install',
      });
    });

    it('installs for global scope without a project key (project-agnostic)', async () => {
      checkScaEnabledSpy.mockResolvedValue(true);
      const sub = createDepRisksSubfeature();
      expect(
        await sub.shouldInstall!(makeInvocation({ scope: 'global', auth: CLOUD_AUTH })),
      ).toMatchObject({ action: 'install' });
    });
  });
});
