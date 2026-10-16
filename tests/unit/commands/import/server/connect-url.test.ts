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

import { describe, expect, it } from 'bun:test';

import { buildConnectUrl } from '@/commands/import/server/connect-url.ts';
import type { DopPlatform } from '@/commands/import/server/server-import-api.ts';

const SERVER_URL = 'https://sonarqube.example.com';

describe('buildConnectUrl', () => {
  it.each<DopPlatform>(['gitlab', 'azure', 'bitbucket', 'bitbucketcloud'])(
    'selects the %s page by mode alone',
    (type) => {
      expect(buildConnectUrl(SERVER_URL, { id: 'id-1', type })).toBe(
        `${SERVER_URL}/projects/create?mode=${type}`,
      );
    },
  );

  it('adds dopSetting for GitHub only', () => {
    expect(buildConnectUrl(SERVER_URL, { id: 'gh-id', type: 'github' })).toBe(
      `${SERVER_URL}/projects/create?mode=github&dopSetting=gh-id`,
    );
    expect(buildConnectUrl(SERVER_URL, { id: 'gl-id', type: 'gitlab' })).not.toContain(
      'dopSetting',
    );
  });

  it.each<DopPlatform>(['github', 'gitlab', 'azure', 'bitbucket', 'bitbucketcloud'])(
    'adds resetPat for %s when asked',
    (type) => {
      const url = new URL(buildConnectUrl(SERVER_URL, { id: 'id-1', type }, { resetPat: true }));
      expect(url.searchParams.get('resetPat')).toBe('1');
      expect(url.searchParams.get('mode')).toBe(type);
    },
  );

  it('omits resetPat by default', () => {
    expect(buildConnectUrl(SERVER_URL, { id: 'id-1', type: 'gitlab' })).not.toContain('resetPat');
  });

  it('drops a trailing slash from the server URL', () => {
    expect(buildConnectUrl(`${SERVER_URL}/`, { id: 'id-1', type: 'gitlab' })).toBe(
      `${SERVER_URL}/projects/create?mode=gitlab`,
    );
  });

  it('keeps a context path on the server URL', () => {
    expect(buildConnectUrl(`${SERVER_URL}/sonar`, { id: 'id-1', type: 'azure' })).toBe(
      `${SERVER_URL}/sonar/projects/create?mode=azure`,
    );
  });

  it('percent-encodes the setting id', () => {
    expect(buildConnectUrl(SERVER_URL, { id: 'a b&c', type: 'github' })).toContain(
      'dopSetting=a+b%26c',
    );
  });
});
