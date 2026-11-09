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
import { startInteractiveSession } from '../../harness/interactive-session.ts';

describe('login connection selection', () => {
  let harness: TestHarness;
  beforeEach(async () => {
    harness = await TestHarness.create();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  function seedConnections(serverUrl: string, authenticated = true) {
    const builder = harness
      .state()
      .withAuth('https://unrelated.example.test', 'active-token')
      .withKeychainToken(serverUrl, 'connection-token');
    const state = builder.build();
    for (const [index, url] of [
      'https://localhost:9443/previous',
      serverUrl,
      'https://localhost:9444/other',
    ].entries()) {
      state.auth.connections.push({
        id: `inactive-${index}`,
        type: 'on-premise',
        serverUrl: url,
        authenticatedAt: '2026-01-01T00:00:00.000Z',
      });
    }
    if (!authenticated) {
      state.auth.isAuthenticated = false;
      state.auth.activeConnectionId = undefined;
    }
    builder.withRawState(JSON.stringify(state));
    return state;
  }

  function tokens(): Record<string, string> {
    return (
      JSON.parse(readFileSync(harness.keychainJsonFile, 'utf8')) as {
        tokens: Record<string, string>;
      }
    ).tokens;
  }

  it.each(['discovered', 'explicit', 'with-token'])(
    'rejects an incompatible %s connection without changing credentials',
    async (source) => {
      const server = await harness.newFakeServer().withAuthToken('connection-token').start();
      const requested = server.baseUrl().replace('127.0.0.1', 'LOCALHOST');
      const state = seedConnections(source === 'discovered' ? requested : `${requested}/next`);
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
      expect(result.stderr).toContain('sonar auth logout --server https://localhost:9443/previous');
      expect(result.stderr).toContain('all saved connections for this hostname');
      expect(result.stdout + result.stderr).not.toContain('Connect to:');
      expect(harness.stateJsonFile.asJson().auth).toEqual(state.auth);
      const keychain = JSON.parse(readFileSync(harness.keychainJsonFile, 'utf8'));
      expect(keychain.tokens.localhost).toBe('connection-token');
      expect(
        server.getRecordedRequests().filter((request) => request.headers.authorization),
      ).toEqual([]);
    },
  );

  it.each([true, false])(
    'clears only the selected hostname with authenticated=%s',
    async (authenticated) => {
      const server = await harness.newFakeServer().withAuthToken('replacement-token').start();
      const state = seedConnections(server.baseUrl(), authenticated);
      // Capture once so the second launch retains the logout state and keychain changes.
      const launchEnvironment = harness.env();
      const result = await harness.run('auth logout --server https://LOCALHOST:9443/previous/');
      expect(result.exitCode).toBe(0);
      expect(harness.stateJsonFile.asJson().auth).toEqual({
        ...state.auth,
        connections: [state.auth.connections[0]],
      });
      expect(tokens()).toEqual({ 'unrelated.example.test': 'active-token' });
      expect(
        server.getRecordedRequests().filter((request) => request.headers.authorization),
      ).toEqual([]);
      const session = startInteractiveSession(
        `auth login --with-token --server ${server.baseUrl()}`,
        launchEnvironment,
        { cwd: harness.cwd.path },
      );
      let login;
      try {
        session.write('replacement-token\n');
        login = await session.waitFinish();
      } finally {
        session.kill();
      }
      expect(login.exitCode).toBe(0);
      expect(tokens().localhost).toBe('replacement-token');
      expect(
        new Set(
          server
            .getRecordedRequests()
            .filter((request) => request.headers.authorization)
            .map((request) => request.headers.authorization),
        ),
      ).toEqual(new Set(['Bearer replacement-token']));
      expect(result.stdout + result.stderr + login.stdout + login.stderr).not.toContain(
        'connection-token',
      );
    },
  );

  it.each([
    ['not-a-url', 2],
    ['https://unknown.example.test', 0],
  ] as const)('leaves credentials unchanged for target %s', async (target, exitCode) => {
    const state = seedConnections('http://localhost:9000');
    const result = await harness.run(`auth logout --server ${target}`);
    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout + result.stderr).toContain(
      exitCode === 2 ? 'must be an absolute HTTP(S) URL' : 'No saved connection matches',
    );
    expect(harness.stateJsonFile.asJson().auth).toEqual(state.auth);
    expect(tokens()).toEqual({
      'unrelated.example.test': 'active-token',
      localhost: 'connection-token',
    });
  });

  it('completes scoped local cleanup after revocation fails', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken('connection-token')
      .withTokenRevocationFailure(500, 'fixture failure')
      .start();
    const state = seedConnections(server.baseUrl());
    state.auth.connections[2].tokenName = 'fixture-token-name';
    harness.state().withRawState(JSON.stringify(state));
    const result = await harness.run(`auth logout --server ${server.baseUrl()}`);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Continuing with local logout.');
    expect(
      server.getRecordedRequests().filter((request) => request.path === '/api/user_tokens/revoke'),
    ).toHaveLength(1);
    expect(harness.stateJsonFile.asJson().auth).toEqual({
      ...state.auth,
      connections: [state.auth.connections[0]],
    });
    expect(tokens()).toEqual({ 'unrelated.example.test': 'active-token' });
    expect(result.stdout + result.stderr).not.toContain('connection-token');
  });

  it('documents the selected hostname scope in command help', async () => {
    const result = await harness.run('auth logout --help');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--server');
    expect(result.stdout.replaceAll(/\s+/g, ' ')).toContain('all saved connections');
    expect(result.stdout).toContain('hostname');
  });

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
