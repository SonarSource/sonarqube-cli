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

import { buildScaUrls } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-urls.ts';
import type { ResolvedAuth } from '../../../../../../src/lib/auth-resolver.ts';

function auth(overrides: Partial<ResolvedAuth>): ResolvedAuth {
  return {
    token: 'token',
    serverUrl: 'https://sonar.example.com',
    connectionType: 'on-premise',
    ...overrides,
  };
}

describe('buildScaUrls', () => {
  it('returns regional API host and SonarCloud scanner host for cloud EU', () => {
    expect(
      buildScaUrls(auth({ serverUrl: 'https://sonarcloud.io', connectionType: 'cloud' })),
    ).toEqual({
      apiBaseUrl: 'https://api.sonarcloud.io/sca',
      downloadBaseUrl: 'https://scanner.sonarcloud.io/tidelift-cli',
    });
  });

  it('returns regional API host and SonarCloud scanner host for cloud US', () => {
    expect(
      buildScaUrls(auth({ serverUrl: 'https://sonarqube.us', connectionType: 'cloud' })),
    ).toEqual({
      apiBaseUrl: 'https://api.sonarqube.us/sca',
      downloadBaseUrl: 'https://scanner.sonarcloud.io/tidelift-cli',
    });
  });

  it('builds /api/v2/sca paths off the server URL for on-premise', () => {
    expect(buildScaUrls(auth({ serverUrl: 'https://sonar.example.com' }))).toEqual({
      apiBaseUrl: 'https://sonar.example.com/api/v2/sca',
      downloadBaseUrl: 'https://sonar.example.com/api/v2/sca/clis',
    });
  });

  it('trims a trailing slash from the on-premise server URL', () => {
    expect(buildScaUrls(auth({ serverUrl: 'https://sonar.example.com/' }))).toEqual({
      apiBaseUrl: 'https://sonar.example.com/api/v2/sca',
      downloadBaseUrl: 'https://sonar.example.com/api/v2/sca/clis',
    });
  });
});
