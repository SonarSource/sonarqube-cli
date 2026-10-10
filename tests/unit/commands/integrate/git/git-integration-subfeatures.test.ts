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

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { okAsync } from '@/core/result.ts';
import { ScaClient } from '@/core/server/sca.ts';

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

const CLOUD_AUTH = new ResolvedAuth({
  serverUrl: 'https://sonarcloud.io',
  token: 'test-token',
  connectionType: 'cloud',
  source: 'state' as const,
  orgKey: 'my-org',
});

describe('createSecretsSubfeature', () => {
  it('is required, so it is never prompted', () => {
    expect(createSecretsSubfeature().required).toBe(true);
  });
});

describe('createDepRisksSubfeature', () => {
  describe('with auth', () => {
    let checkScaEnabledSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      checkScaEnabledSpy = spyOn(ScaClient.prototype, 'checkScaEnabled');
    });

    afterEach(() => {
      checkScaEnabledSpy.mockRestore();
    });

    it('is unavailable with the SCA unavailability reason when SCA is not enabled on the connection', async () => {
      checkScaEnabledSpy.mockReturnValue(okAsync(false));
      const sub = createDepRisksSubfeature();
      const availability = await sub.isAvailable!(
        makeInvocation({ options: { project: 'my-project' }, auth: CLOUD_AUTH }),
      );
      expect(availability.available).toBe(false);
      expect(availability.unavailableReason).toContain(
        'Software Composition Analysis is not available for the current connection.',
      );
    });

    it('is available when SCA is enabled, with or without a project key', async () => {
      checkScaEnabledSpy.mockReturnValue(okAsync(true));
      const sub = createDepRisksSubfeature();
      expect(
        await sub.isAvailable!(
          makeInvocation({ options: { project: 'my-project' }, auth: CLOUD_AUTH }),
        ),
      ).toEqual({ available: true });
      expect(await sub.isAvailable!(makeInvocation({ auth: CLOUD_AUTH }))).toEqual({
        available: true,
      });
      expect(await sub.isAvailable!(makeInvocation({ scope: 'global', auth: CLOUD_AUTH }))).toEqual(
        { available: true },
      );
    });
  });
});
