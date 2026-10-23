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

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { authMatchesRecordedConnection } from '@/core/auth/recorded-connection.ts';

const cloud = new ResolvedAuth({
  token: 't',
  serverUrl: 'https://sonarcloud.io',
  orgKey: 'org-a',
  connectionType: 'cloud',
  source: 'state',
});
const server = new ResolvedAuth({
  token: 't',
  serverUrl: 'https://sonar.example.com',
  connectionType: 'on-premise',
  source: 'state',
});

describe('authMatchesRecordedConnection', () => {
  it('matches Cloud only for the same organization', () => {
    expect(
      authMatchesRecordedConnection(cloud, {
        serverUrl: 'https://sonarcloud.io/',
        organization: 'org-a',
      }),
    ).toBe(true);
    expect(
      authMatchesRecordedConnection(cloud, {
        serverUrl: 'https://sonarcloud.io',
        organization: 'org-b',
      }),
    ).toBe(false);
    expect(authMatchesRecordedConnection(cloud, { serverUrl: 'https://sonarcloud.io' })).toBe(
      false,
    );
  });

  it('rejects a different server and ignores organization on Server', () => {
    expect(
      authMatchesRecordedConnection(server, {
        serverUrl: 'https://sonarcloud.io',
        organization: 'org-a',
      }),
    ).toBe(false);
    expect(authMatchesRecordedConnection(server, { serverUrl: 'https://sonar.example.com' })).toBe(
      true,
    );
  });
});
