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

import { InvalidOptionError } from '../../../../../../src/cli/commands/_common/error.js';
import type { IntegrateGitOptions } from '../../../../../../src/cli/commands/integrate/git/options.js';
import {
  createDepRisksSubfeature,
  createSecretsSubfeature,
} from '../../../../../../src/cli/commands/integrate/git/tools/git-integration-subfeatures.js';
import type { ResolvedAuth } from '../../../../../../src/lib/auth-resolver.js';
import { SonarQubeClient } from '../../../../../../src/sonarqube/client.js';

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
  it('skips for global scope', async () => {
    const sub = createDepRisksSubfeature();
    expect(await sub.shouldInstall!(makeInvocation({ scope: 'global' }))).toMatchObject({
      action: 'skip',
      message: 'Dependency-risks scanning is not available for global hooks',
    });
  });

  it('throws InvalidOptionError when --dependency-risks is set without a project key', async () => {
    const sub = createDepRisksSubfeature();
    /* eslint-disable @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable */
    await expect(
      sub.shouldInstall!(makeInvocation({ options: { dependencyRisks: true } })),
    ).rejects.toThrow(InvalidOptionError);
    /* eslint-enable @typescript-eslint/await-thenable */
  });

  it('skips with message when no project key is available', async () => {
    const sub = createDepRisksSubfeature();
    expect(await sub.shouldInstall!(makeInvocation())).toMatchObject({
      action: 'skip',
      message: 'Dependency-risks scanning is not available without a project key.',
    });
  });

  it('installs when --dependency-risks and project key are both set (no auth)', async () => {
    const sub = createDepRisksSubfeature();
    expect(
      await sub.shouldInstall!(
        makeInvocation({ options: { dependencyRisks: true, project: 'my-project' } }),
      ),
    ).toMatchObject({ action: 'install' });
  });

  it('asks user when project key is set but --dependency-risks is not (no auth)', async () => {
    const sub = createDepRisksSubfeature();
    expect(
      await sub.shouldInstall!(makeInvocation({ options: { project: 'my-project' } })),
    ).toMatchObject({ action: 'ask' });
  });

  it('asks user in non-interactive mode when --dependency-risks is not set (installer converts ask+nonInteractive to install)', async () => {
    const sub = createDepRisksSubfeature();
    expect(
      await sub.shouldInstall!(
        makeInvocation({ options: { project: 'my-project' }, nonInteractive: true }),
      ),
    ).toMatchObject({ action: 'ask' });
  });

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

    it('asks user when SCA is available and --dependency-risks is not set', async () => {
      checkScaEnabledSpy.mockResolvedValue(true);
      const sub = createDepRisksSubfeature();
      expect(
        await sub.shouldInstall!(
          makeInvocation({ options: { project: 'my-project' }, auth: CLOUD_AUTH }),
        ),
      ).toMatchObject({ action: 'ask' });
    });

    it('installs when SCA is available and --dependency-risks is set', async () => {
      checkScaEnabledSpy.mockResolvedValue(true);
      const sub = createDepRisksSubfeature();
      expect(
        await sub.shouldInstall!(
          makeInvocation({
            options: { project: 'my-project', dependencyRisks: true },
            auth: CLOUD_AUTH,
          }),
        ),
      ).toMatchObject({ action: 'install' });
    });
  });
});
