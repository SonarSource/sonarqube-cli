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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { identityCacheKey, readFreshFlagDecisions } from '@/core/launch-darkly/cache.ts';
import type { FeatureFlagIdentity } from '@/core/launch-darkly/types.ts';

const identity: FeatureFlagIdentity = {
  connectionType: 'cloud',
  userUuid: 'user-1',
  organizationUuidV4: 'org-1',
  sqsInstallationId: null,
};

function writeRawCache(tempHome: string, body: unknown): void {
  const dir = join(tempHome, 'sonarqube-cli', 'launch-darkly');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'beta-flags-cache.json'), `${JSON.stringify(body, null, 2)}\n`);
}

describe('readFreshFlagDecisions', () => {
  let tempHome: string;
  let previousUserHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'sqcli-ld-cache-'));
    previousUserHome = process.env.SONAR_USER_HOME;
    process.env.SONAR_USER_HOME = tempHome;
  });

  afterEach(() => {
    if (previousUserHome === undefined) {
      delete process.env.SONAR_USER_HOME;
    } else {
      process.env.SONAR_USER_HOME = previousUserHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('ignores entries with a non-numeric fetchedAt', () => {
    writeRawCache(tempHome, {
      clientSideId: 'client-id',
      entries: {
        [identityCacheKey(identity)]: {
          fetchedAt: 'yesterday',
          flags: { 'cli.beta.private': true },
        },
      },
    });

    expect(readFreshFlagDecisions(identity, ['cli.beta.private'], 'client-id', 1_000)).toBeNull();
  });

  it('ignores entries with a missing flags object', () => {
    writeRawCache(tempHome, {
      clientSideId: 'client-id',
      entries: {
        [identityCacheKey(identity)]: {
          fetchedAt: 1_000,
        },
      },
    });

    expect(readFreshFlagDecisions(identity, ['cli.beta.private'], 'client-id', 1_000)).toBeNull();
  });

  it('ignores entries whose flag values are not booleans', () => {
    writeRawCache(tempHome, {
      clientSideId: 'client-id',
      entries: {
        [identityCacheKey(identity)]: {
          fetchedAt: 1_000,
          flags: { 'cli.beta.private': 'yes' },
        },
      },
    });

    expect(readFreshFlagDecisions(identity, ['cli.beta.private'], 'client-id', 1_000)).toBeNull();
  });

  it('keeps valid entries while dropping malformed neighbors', () => {
    writeRawCache(tempHome, {
      clientSideId: 'client-id',
      entries: {
        'cloud|user:bad|organization:|installation:': {
          fetchedAt: 'nope',
          flags: { 'cli.beta.private': true },
        },
        [identityCacheKey(identity)]: {
          fetchedAt: 1_000,
          flags: { 'cli.beta.private': true, 'cli.beta.other': false },
        },
      },
    });

    expect(readFreshFlagDecisions(identity, ['cli.beta.private'], 'client-id', 1_000)).toEqual({
      'cli.beta.private': true,
    });
  });
});
