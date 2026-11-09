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

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('login connection selection', () => {
  let harness: TestHarness;
  beforeEach(async () => {
    harness = await TestHarness.create();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it.each(['discovered', 'explicit', 'with-token'])(
    'rejects an incompatible %s connection without changing credentials',
    async (source) => {
      const server = await harness.newFakeServer().withAuthToken('connection-token').start();
      const requested = server.baseUrl().replace('127.0.0.1', 'LOCALHOST');
      const saved = 'https://localhost:9443/previous';
      const builder = harness
        .state()
        .withAuth('https://unrelated.example.test', 'active-token')
        .withKeychainToken(saved, 'connection-token');
      const state = builder.build();
      state.auth.connections.push({
        id: 'inactive',
        type: 'on-premise',
        serverUrl: saved,
        authenticatedAt: '2026-01-01T00:00:00.000Z',
      });
      builder.withRawState(JSON.stringify(state));
      harness.cwd.writeFile(
        'sonar-project.properties',
        `sonar.host.url=${requested}
sonar.projectKey=sample
`,
      );
      const command =
        source === 'discovered'
          ? 'auth login'
          : `auth login ${source === 'with-token' ? '--with-token ' : ''}--server ${requested}/next`;
      const result =
        source === 'with-token'
          ? await harness.runWithStdin(command, 'replacement-token\n')
          : await harness.run(command);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('sonar auth logout');
      expect(result.stdout + result.stderr).not.toContain('Connect to:');
      expect(harness.stateJsonFile.asJson().auth).toEqual(state.auth);
      const keychain = JSON.parse(readFileSync(harness.keychainJsonFile, 'utf8'));
      expect(keychain.tokens.localhost).toBe('connection-token');
      expect(
        server.getRecordedRequests().filter((request) => request.headers.authorization),
      ).toEqual([]);
    },
  );

  it('accepts a previously saved HTTP connection', async () => {
    const server = await harness.newFakeServer().withAuthToken('connection-token').start();
    harness.withAuth(server.baseUrl(), 'connection-token');
    const result = await harness.runWithStdin(
      `auth login --with-token --server ${server.baseUrl()}`,
      'connection-token\n',
    );
    expect(result.exitCode).toBe(0);
  });

  it('accepts an HTTP connection on an unrelated hostname', async () => {
    const server = await harness.newFakeServer().withAuthToken('connection-token').start();
    harness.withAuth('https://unrelated.example.test', 'previous-token');
    const result = await harness.runWithStdin(
      `auth login --with-token --server ${server.baseUrl()}`,
      'connection-token\n',
    );
    expect(result.exitCode).toBe(0);
  });
});
