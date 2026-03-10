/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Integration tests for `sonar auth login`, `auth logout`, `auth purge`, and `auth status`

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestHarness } from '../../harness';

describe('auth login', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 when --server is not a valid URL',
    async () => {
      const result = await harness.run('auth login --server not-a-url --with-token mytoken');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Invalid server URL');
    },
    { timeout: 15000 },
  );

  it(
    'saves token to keychain and state after --with-token and --server',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('my-login-token').start();

      const result = await harness.run(
        `auth login --with-token my-login-token --server ${server.baseUrl()}`,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Authentication successful');

      // Verify keychain file was written with the token
      expect(harness.keychainJsonFile.exists()).toBe(true);
      const keychain = harness.keychainJsonFile.asJson() as {
        tokens: Record<string, string>;
      };
      // Account key is hostname of the server (127.0.0.1)
      expect(Object.values(keychain.tokens)).toContain('my-login-token');

      // Verify state.json has a connection
      const state = harness.stateJsonFile.asJson();
      expect(state.auth.connections.length).toBeGreaterThan(0);
      expect(state.auth.connections[0].serverUrl).toBe(server.baseUrl());
    },
    { timeout: 15000 },
  );
});

describe('auth login — organization selection', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'auto-selects the single org when user is a member of exactly one organization',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('my-token')
        .withOrganizations([{ key: 'my-org', name: 'My Org' }])
        .start();

      const result = await harness.run(
        `auth login --with-token my-token --server ${server.baseUrl()}`,
        {
          extraEnv: {
            SONAR_CLI_SONARCLOUD_URL: server.baseUrl(),
            SONAR_CLI_SONARCLOUD_API_URL: server.baseUrl(),
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Authentication successful');
      expect(result.stdout).toContain('my-org');

      const state = harness.stateJsonFile.asJson() as {
        auth: { connections: Array<{ orgKey: string }> };
      };
      expect(state.auth.connections[0].orgKey).toBe('my-org');
    },
    { timeout: 15000 },
  );

  it(
    'prompts for manual org key when user is not a member of any organization',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('my-token').start();

      const result = await harness.run(`auth login --server ${server.baseUrl()}`, {
        extraEnv: {
          SONAR_CLI_SONARCLOUD_URL: server.baseUrl(),
          SONAR_CLI_SONARCLOUD_API_URL: server.baseUrl(),
        },
        browserToken: 'my-token',
        stdin: 'open-source-org\r',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        `Authentication successful for: ${server.baseUrl()} (open-source-org)`,
      );
    },
    { timeout: 15000 },
  );

  it(
    'exits with error when user cancels the organization prompt',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('my-token').start();

      const result = await harness.run(`auth login --server ${server.baseUrl()}`, {
        extraEnv: {
          SONAR_CLI_SONARCLOUD_URL: server.baseUrl(),
          SONAR_CLI_SONARCLOUD_API_URL: server.baseUrl(),
        },
        browserToken: 'my-token',
        stdin: '\x03', // Ctrl+C
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('Organization selection cancelled');
    },
    { timeout: 15000 },
  );

  it('exits with error when user enters an empty organization key', async () => {
    const server = await harness.newFakeServer().withAuthToken('my-token').start();

    const result = await harness.run(`auth login --server ${server.baseUrl()}`, {
      extraEnv: {
        SONAR_CLI_SONARCLOUD_URL: server.baseUrl(),
        SONAR_CLI_SONARCLOUD_API_URL: server.baseUrl(),
      },
      browserToken: 'my-token',
      stdin: '\r', // Enter
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('Organization key is required');
  });

  it('lets user select an organization from a list when user is a member of multiple organizations', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken('my-token')
      .withOrganizations([
        { key: 'my-org', name: 'My Org' },
        { key: 'my-org-2', name: 'My Org 2' },
      ])
      .start();

    const result = await harness.run(`auth login --server ${server.baseUrl()}`, {
      extraEnv: {
        SONAR_CLI_SONARCLOUD_URL: server.baseUrl(),
        SONAR_CLI_SONARCLOUD_API_URL: server.baseUrl(),
      },
      browserToken: 'my-token',
      stdin: '\x1b[B\r', // down once, enter
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `Authentication successful for: ${server.baseUrl()} (my-org-2)`,
    );
  });

  it('shows a message when user is a member of more than 10 organizations', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken('my-token')
      .withOrganizations(
        Array.from({ length: 10 }, (_, i) => ({ key: `org-${i}`, name: `Org ${i}` })),
      )
      .withOrganizationTotal(200)
      .start();

    const result = await harness.run(`auth login --server ${server.baseUrl()}`, {
      extraEnv: {
        SONAR_CLI_SONARCLOUD_URL: server.baseUrl(),
        SONAR_CLI_SONARCLOUD_API_URL: server.baseUrl(),
      },
      browserToken: 'my-token',
      stdin: '\x1b[B\x1b[B\r', // down twice, enter
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'Showing first 10 of 200 organizations. Use manual entry to select a different organization.',
    );
    expect(result.stdout).toContain(`Authentication successful for: ${server.baseUrl()} (org-2)`);
  });

  it('should remove the "waiting for authorization..." line when token is received', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken('my-token')
      .withOrganizations([
        { key: 'my-org', name: 'My Org' },
        { key: 'my-org-2', name: 'My Org 2' },
      ])
      .start();

    const result = await harness.run(`auth login --server ${server.baseUrl()}`, {
      extraEnv: {
        SONAR_CLI_SONARCLOUD_URL: server.baseUrl(),
        SONAR_CLI_SONARCLOUD_API_URL: server.baseUrl(),
      },
      browserToken: 'my-token',
      stdin: '\x1b[B\r', // down once, enter
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `Authentication successful for: ${server.baseUrl()} (my-org-2)`,
    );
    expect(result.stdout).not.toContain('Waiting for authorization...');
  });
});

describe('auth logout', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'removes token from keychain and connection from state when logout succeeds',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('logout-token').start();

      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'logout-token');

      const result = await harness.run(`auth logout --server ${server.baseUrl()}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Logged out');

      // Verify token was removed from keychain
      expect(harness.keychainJsonFile.exists()).toBe(true);
      const keychain = harness.keychainJsonFile.asJson() as {
        tokens: Record<string, string>;
      };
      expect(Object.values(keychain.tokens)).not.toContain('logout-token');
    },
    { timeout: 15000 },
  );

  it(
    'exits gracefully when no token exists for the server',
    async () => {
      const server = await harness.newFakeServer().start();
      // No token in keychain — nothing to logout

      const result = await harness.run(`auth logout --server ${server.baseUrl()}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No token found');
    },
    { timeout: 15000 },
  );
});

describe('auth purge', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 0 and reports no tokens when keychain is empty',
    async () => {
      const result = await harness.run('auth purge');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No tokens found');
    },
    { timeout: 15000 },
  );

  it(
    'removes all tokens after confirmation',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('purge-token-1').start();

      const server2 = await harness.newFakeServer().withAuthToken('purge-token-2').start();

      harness
        .state()
        .withKeychainToken(server.baseUrl(), 'purge-token-1')
        .withKeychainToken(server2.baseUrl(), 'purge-token-2');

      // ConfirmPrompt is not bypassed by CI=true — send 'y' via stdin
      const result = await harness.run('auth purge', { stdin: 'y\n' });

      expect(result.exitCode).toBe(0);

      // All tokens must have been removed from the keychain file
      expect(harness.keychainJsonFile.exists()).toBe(true);
      const keychain = harness.keychainJsonFile.asJson() as {
        tokens: Record<string, string>;
      };
      expect(Object.keys(keychain.tokens ?? {}).length).toBe(0);
    },
    { timeout: 15000 },
  );
});

describe('auth status', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'reports not authenticated when no connection exists in state',
    async () => {
      const result = await harness.run('auth status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No saved connection');
    },
    { timeout: 15000 },
  );

  it(
    'reports token missing when connection exists but no keychain token',
    async () => {
      const server = await harness.newFakeServer().start();
      harness.state().withActiveConnection(server.baseUrl());
      // No withKeychainToken

      const result = await harness.run('auth status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Token missing');
    },
    { timeout: 15000 },
  );

  it(
    'reports connected when connection and token are both present',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('status-token').start();

      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'status-token');

      const result = await harness.run('auth status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Connected');
    },
    { timeout: 15000 },
  );
});
