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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildLaunchDarklyContext, type FeatureFlagIdentity } from '@/core/launch-darkly';

describe('buildLaunchDarklyContext', () => {
  let previousUserHome: string | undefined;

  beforeEach(() => {
    previousUserHome = process.env.SONAR_USER_HOME;
  });

  afterEach(() => {
    if (previousUserHome === undefined) {
      delete process.env.SONAR_USER_HOME;
    } else {
      process.env.SONAR_USER_HOME = previousUserHome;
    }
  });

  it('builds a Cloud multi-context from user and organization UUIDs', () => {
    const identity: FeatureFlagIdentity = {
      connectionType: 'cloud',
      userUuid: 'user-1',
      organizationUuidV4: 'org-1',
      enterpriseUuid: null,
      sqsInstallationId: null,
    };

    expect(buildLaunchDarklyContext(identity)).toEqual({
      kind: 'multi',
      user: { key: 'user-1' },
      organization: { key: 'org-1' },
    });
  });

  it('adds an enterprise context when the Cloud enterprise UUID is known', () => {
    const identity: FeatureFlagIdentity = {
      connectionType: 'cloud',
      userUuid: 'user-1',
      organizationUuidV4: 'org-1',
      enterpriseUuid: 'ent-1',
      sqsInstallationId: null,
    };

    expect(buildLaunchDarklyContext(identity)).toEqual({
      kind: 'multi',
      user: { key: 'user-1' },
      organization: { key: 'org-1' },
      enterprise: { key: 'ent-1' },
    });
  });

  it('builds a Server multi-context when both installation and user are known', () => {
    const identity: FeatureFlagIdentity = {
      connectionType: 'on-premise',
      userUuid: 'user-1',
      organizationUuidV4: null,
      enterpriseUuid: null,
      sqsInstallationId: 'install-1',
    };

    expect(buildLaunchDarklyContext(identity)).toEqual({
      kind: 'multi',
      installation: { key: 'install-1' },
      user: { key: 'user-1' },
    });
  });

  it('builds a Server installation context when user UUID is absent', () => {
    const identity: FeatureFlagIdentity = {
      connectionType: 'on-premise',
      userUuid: null,
      organizationUuidV4: null,
      enterpriseUuid: null,
      sqsInstallationId: 'install-1',
    };

    expect(buildLaunchDarklyContext(identity)).toEqual({
      kind: 'installation',
      key: 'install-1',
    });
  });

  it('returns null when required Cloud identity fields are missing', () => {
    expect(
      buildLaunchDarklyContext({
        connectionType: 'cloud',
        userUuid: 'user-1',
        organizationUuidV4: null,
        enterpriseUuid: null,
        sqsInstallationId: null,
      }),
    ).toBeNull();
  });

  it('returns null when Server identity has no installation id', () => {
    expect(
      buildLaunchDarklyContext({
        connectionType: 'on-premise',
        userUuid: 'user-1',
        organizationUuidV4: null,
        enterpriseUuid: null,
        sqsInstallationId: null,
      }),
    ).toBeNull();
  });
});
