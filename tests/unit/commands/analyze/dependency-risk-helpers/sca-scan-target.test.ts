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

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import {
  type CompleteProjectMapping,
  DiscoveredProjects,
} from '@/core/project-discovery/project-discovery-result.ts';
import * as projectInfo from '@/core/project-discovery/project-info.ts';

import { resolveScaScanTarget } from '../../../../../src/commands/analyze/dependency-risk-helpers/sca-scan-target.ts';
import { FakeConsole } from '../../../../_common/fake-console.ts';

const REPO = canonicalizePath(process.cwd());

const AUTH = new ResolvedAuth({
  token: 'test-token',
  serverUrl: 'https://sonarcloud.io',
  orgKey: 'my-org',
  connectionType: 'cloud',
  source: 'state',
});

function project(projectKey: string, path: string): CompleteProjectMapping {
  return { projectKey, projectRoot: join(REPO, path), serverUrl: AUTH.serverUrl };
}

describe('resolveScaScanTarget', () => {
  let discoverProjectsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    discoverProjectsSpy = spyOn(projectInfo, 'discoverProjects').mockResolvedValue(
      new DiscoveredProjects(
        REPO,
        [project('api', 'services/api'), project('web', 'apps/web')],
        true,
      ),
    );
  });

  afterEach(() => {
    discoverProjectsSpy.mockRestore();
  });

  it('scans the root of the single project covering the directory', async () => {
    const cwd = join(REPO, 'apps', 'web', 'src');

    const target = await resolveScaScanTarget(undefined, AUTH, new FakeConsole(), cwd);

    expect(target).toEqual({ projectKey: 'web', baseDir: join(REPO, 'apps', 'web') });
  });

  it('scans the root of the linked project matching an explicit key', async () => {
    const target = await resolveScaScanTarget('api', AUTH, new FakeConsole(), REPO);

    expect(target).toEqual({ projectKey: 'api', baseDir: join(REPO, 'services', 'api') });
  });

  it('scans the current directory for an explicit key that is not linked', async () => {
    const target = await resolveScaScanTarget('other', AUTH, new FakeConsole(), REPO);

    expect(target).toEqual({ projectKey: 'other', baseDir: REPO });
  });

  it('rejects a directory covering several linked projects', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(resolveScaScanTarget(undefined, AUTH, new FakeConsole(), REPO)).rejects.toThrow(
      `Could not determine a single SonarQube project for ${REPO}.`,
    );
  });
});
