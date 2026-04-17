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

// Integration tests for `sonar auth login`, `auth logout`, `auth purge`, and `auth status`

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { generateKeychainAccount } from '../../../../src/lib/keychain';
import { TestHarness } from '../../harness';

function readKeychainToken(keychainFile: string, account: string): string | undefined {
  try {
    const store = JSON.parse(readFileSync(keychainFile, 'utf-8')) as {
      tokens: Record<string, string>;
    };
    return store.tokens[account];
  } catch {
    return undefined;
  }
}

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

      const account = generateKeychainAccount(server.baseUrl());
      expect(readKeychainToken(harness.keychainJsonFile, account)).toBe('my-login-token');

      // Verify state.json has a connection
      const state = harness.stateJsonFile.asJson();
      expect(state.auth.connections.length).toBeGreaterThan(0);
      expect(state.auth.connections[0].serverUrl).toBe(server.baseUrl());
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when organization is not found on SonarCloud',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('my-token').start();

      const result = await harness.run('auth login --with-token my-token --org nonexistent-org', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl(),
          SONARQUBE_CLI_SONARCLOUD_API_URL: server.baseUrl(),
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        'Organization "nonexistent-org" not found or not accessible',
      );
    },
    { timeout: 15000 },
  );
});

const LARGE_ORG_TOTAL = 200;

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
            SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl(),
            SONARQUBE_CLI_SONARCLOUD_API_URL: server.baseUrl(),
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
          SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl(),
          SONARQUBE_CLI_SONARCLOUD_API_URL: server.baseUrl(),
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
          SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl(),
          SONARQUBE_CLI_SONARCLOUD_API_URL: server.baseUrl(),
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
        SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl(),
        SONARQUBE_CLI_SONARCLOUD_API_URL: server.baseUrl(),
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
        SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl(),
        SONARQUBE_CLI_SONARCLOUD_API_URL: server.baseUrl(),
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
      .withOrganizationTotal(LARGE_ORG_TOTAL)
      .start();

    const result = await harness.run(`auth login --server ${server.baseUrl()}`, {
      extraEnv: {
        SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl(),
        SONARQUBE_CLI_SONARCLOUD_API_URL: server.baseUrl(),
      },
      browserToken: 'my-token',
      stdin: '\x1b[B\x1b[B\r', // down twice, enter
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `Showing first 10 of ${LARGE_ORG_TOTAL} organizations. Use manual entry to select a different organization.`,
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
        SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl(),
        SONARQUBE_CLI_SONARCLOUD_API_URL: server.baseUrl(),
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

  it(
    'uses organization from sonar-project.properties when --org is not specified',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('my-token')
        .withOrganizations([{ key: 'my-org', name: 'My Org' }])
        .start();

      harness.cwd.writeFile('sonar-project.properties', 'sonar.organization=my-org\n');

      const result = await harness.run('auth login', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl(),
          SONARQUBE_CLI_SONARCLOUD_API_URL: server.baseUrl(),
        },
        browserToken: 'my-token',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('my-org');
    },
    { timeout: 15000 },
  );
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

      const result = await harness.run(`auth logout`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Logged out from: ${server.baseUrl()}`);

      const account = generateKeychainAccount(server.baseUrl());
      expect(readKeychainToken(harness.keychainJsonFile, account)).toBeUndefined();
      expect(harness.stateJsonFile.asJson().auth.activeConnectionId).toBeUndefined();
      expect(harness.stateJsonFile.asJson().auth.isAuthenticated).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'clears state when a connection exists but the keychain has no token',
    async () => {
      const server = await harness.newFakeServer().start();
      harness.state().withActiveConnection(server.baseUrl());

      const result = await harness.run(`auth logout`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Logged out from: ${server.baseUrl()}`);
      expect(harness.stateJsonFile.asJson().auth.activeConnectionId).toBeUndefined();
      expect(harness.stateJsonFile.asJson().auth.isAuthenticated).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'reports already logged out when there is no saved connection',
    async () => {
      const result = await harness.run(`auth logout`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('You are already logged out.');
    },
    { timeout: 15000 },
  );

  it(
    'does not remove a second org token when logging out from the active org',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('token-org1').start();

      harness
        .state()
        .withActiveConnection(server.baseUrl(), 'cloud', 'org1')
        .withKeychainToken(server.baseUrl(), 'token-org1', 'org1')
        .withKeychainToken(server.baseUrl(), 'token-org2', 'org2');

      const result = await harness.run('auth logout');

      expect(result.exitCode).toBe(0);

      const account1 = generateKeychainAccount(server.baseUrl(), 'org1');
      const account2 = generateKeychainAccount(server.baseUrl(), 'org2');
      expect(readKeychainToken(harness.keychainJsonFile, account1)).toBeUndefined();
      expect(readKeychainToken(harness.keychainJsonFile, account2)).toBe('token-org2');
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

      const result = await harness.run('auth purge', { stdin: 'y\n' });

      expect(result.exitCode).toBe(0);

      const account1 = generateKeychainAccount(server.baseUrl());
      const account2 = generateKeychainAccount(server2.baseUrl());
      expect(readKeychainToken(harness.keychainJsonFile, account1)).toBeUndefined();
      expect(readKeychainToken(harness.keychainJsonFile, account2)).toBeUndefined();
    },
    { timeout: 15000 },
  );
});

describe('auth login — auth URL', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'uses /auth endpoint for SQS >= 2026.2',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('my-token')
        .withVersion('2026.2')
        .start();

      const result = await harness.run(`auth login --server ${server.baseUrl()}`, {
        browserToken: 'my-token',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('/auth?product=cli&port=');
      expect(result.stdout).not.toContain('/sonarlint/auth');
    },
    { timeout: 15000 },
  );

  it(
    'uses /auth endpoint for SQS Community >= 26.2',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('my-token')
        .withVersion('26.2')
        .start();

      const result = await harness.run(`auth login --server ${server.baseUrl()}`, {
        browserToken: 'my-token',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('/auth?product=cli&port=');
      expect(result.stdout).not.toContain('/sonarlint/auth');
    },
    { timeout: 15000 },
  );

  it(
    'uses legacy /sonarlint/auth endpoint for SQS < 2026.2',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('my-token')
        .withVersion('2025.1')
        .start();

      const result = await harness.run(`auth login --server ${server.baseUrl()}`, {
        browserToken: 'my-token',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('/sonarlint/auth?ideName=sonarqube-cli&port=');
    },
    { timeout: 15000 },
  );

  it(
    'uses legacy /sonarlint/auth endpoint for SQS Community < 26.2',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('my-token')
        .withVersion('25.1')
        .start();

      const result = await harness.run(`auth login --server ${server.baseUrl()}`, {
        browserToken: 'my-token',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('/sonarlint/auth?ideName=sonarqube-cli&port=');
    },
    { timeout: 15000 },
  );

  it(
    'falls back to legacy /sonarlint/auth endpoint when /api/system/status returns 503',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('my-token')
        .withSystemStatusCode(503)
        .start();

      const result = await harness.run(`auth login --server ${server.baseUrl()}`, {
        browserToken: 'my-token',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('/sonarlint/auth?ideName=sonarqube-cli&port=');
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
