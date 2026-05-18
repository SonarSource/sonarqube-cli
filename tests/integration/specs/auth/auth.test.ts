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

import { ENV_ORG, ENV_SERVER, ENV_TOKEN } from '../../../../src/lib/auth-resolver';
import { SONARCLOUD_URL, SONARCLOUD_US_URL } from '../../../../src/lib/config-constants';
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
    'exits with code 2 when --server is not a valid URL',
    async () => {
      const result = await harness.run('auth login --server not-a-url --with-token mytoken');

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Invalid server URL');
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
    'persists tokenName returned by the browser auth callback',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('browser-login-token').start();

      const result = await harness.run(`auth login --server ${server.baseUrl()}`, {
        browserToken: 'browser-login-token',
        browserTokenName: 'cli-browser-token',
      });

      expect(result.exitCode).toBe(0);
      const state = harness.stateJsonFile.asJson() as {
        auth: { connections: Array<{ tokenName?: string; serverUrl: string }> };
      };
      expect(state.auth.connections[0].serverUrl).toBe(server.baseUrl());
      expect(state.auth.connections[0].tokenName).toBe('cli-browser-token');
    },
    { timeout: 15000 },
  );

  it(
    'does not inherit a stale tokenName when re-authenticating with --with-token',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('manual-token').start();

      // Pre-existing state: a prior browser-OAuth login left a tokenName behind.
      // The keychain token has since been replaced by a manually-supplied one.
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withTokenName('cli-browser-token-from-prior-session');

      const result = await harness.run(
        `auth login --server ${server.baseUrl()} --with-token manual-token`,
      );

      expect(result.exitCode).toBe(0);
      const state = harness.stateJsonFile.asJson() as {
        auth: { connections: Array<{ tokenName?: string; serverUrl: string }> };
      };
      // The manually-supplied token has no server-side name we can know about,
      // so the connection must NOT carry the stale browser-issued tokenName forward.
      expect(state.auth.connections[0].serverUrl).toBe(server.baseUrl());
      expect(state.auth.connections[0].tokenName).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it(
    'preserves tokenName when re-authenticating with the existing keychain token',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('browser-login-token').start();

      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withTokenName('cli-browser-token')
        .withKeychainToken(server.baseUrl(), 'browser-login-token');

      const result = await harness.run(`auth login --server ${server.baseUrl()}`);

      expect(result.exitCode).toBe(0);
      const state = harness.stateJsonFile.asJson() as {
        auth: { connections: Array<{ tokenName?: string; serverUrl: string }> };
      };
      expect(state.auth.connections[0].serverUrl).toBe(server.baseUrl());
      expect(state.auth.connections[0].tokenName).toBe('cli-browser-token');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when organization is not found on SonarCloud',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('my-token').start();

      const result = await harness.run(
        `auth login --with-token my-token --org nonexistent-org --server ${server.baseUrl()}`,
        {
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl(),
            SONARQUBE_CLI_SONARCLOUD_API_URL: server.baseUrl(),
          },
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Organization "nonexistent-org" not found or not accessible');
    },
    { timeout: 15000 },
  );

  it(
    'saves token and org when logging in to SonarCloud US',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('my-token')
        .withOrganizations([{ key: 'us-org', name: 'US Org' }])
        .start();

      const result = await harness.run(
        `auth login --with-token my-token --server ${server.baseUrl()}`,
        {
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_US_URL: server.baseUrl(),
            SONARQUBE_CLI_SONARCLOUD_US_API_URL: server.baseUrl(),
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Authentication successful');

      const state = harness.stateJsonFile.asJson() as {
        auth: { connections: Array<{ type: string; orgKey: string; region: string }> };
      };
      expect(state.auth.connections[0].type).toBe('cloud');
      expect(state.auth.connections[0].orgKey).toBe('us-org');
      expect(state.auth.connections[0].region).toBe('us');
    },
    { timeout: 15000 },
  );

  it(
    'preserves telemetry.installationId when logging in to a second server',
    async () => {
      const server1 = await harness.newFakeServer().withAuthToken('tok-1').start();
      const server2 = await harness.newFakeServer().withAuthToken('tok-2').start();

      await harness.run(`auth login --with-token tok-1 --server ${server1.baseUrl()}`);
      const { installationId } = (
        harness.stateJsonFile.asJson() as { telemetry: { installationId: string } }
      ).telemetry;

      await harness.run(`auth login --with-token tok-2 --server ${server2.baseUrl()}`);
      const stateAfter = harness.stateJsonFile.asJson() as {
        telemetry: { installationId: string };
        auth: { connections: Array<{ serverUrl: string }> };
      };

      expect(stateAfter.telemetry.installationId).toBe(installationId);
      expect(stateAfter.auth.connections[0].serverUrl).toBe(server2.baseUrl());
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
      expect(result.stderr).toContain('Organization selection cancelled');
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
    expect(result.stderr).toContain('Organization key is required');
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

      harness.cwd.writeFile(
        'sonar-project.properties',
        `sonar.host.url=${server.baseUrl()}\nsonar.organization=my-org\n`,
      );

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

describe('auth login — server selection', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'prompts for server and logs in to SonarQube Cloud EU',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('my-token')
        .withOrganizations([{ key: 'my-org', name: 'My Org' }])
        .start();

      const result = await harness.run('auth login', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl(),
          SONARQUBE_CLI_SONARCLOUD_API_URL: server.baseUrl(),
        },
        browserToken: 'my-token',
        stdinChunks: ['\r', '\r'], // Enter (Cloud), Enter (EU)
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Authentication successful');
      const state = harness.stateJsonFile.asJson() as {
        auth: { connections: Array<{ region: string }> };
      };
      expect(state.auth.connections[0].region).toBe('eu');
    },
    { timeout: 15000 },
  );

  it(
    'prompts for server and logs in to SonarQube Cloud US',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('my-token')
        .withOrganizations([{ key: 'us-org', name: 'US Org' }])
        .start();

      const result = await harness.run('auth login', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_US_URL: server.baseUrl(),
          SONARQUBE_CLI_SONARCLOUD_US_API_URL: server.baseUrl(),
        },
        browserToken: 'my-token',
        stdinChunks: ['\r', '\x1b[B\r'], // Enter (Cloud), down+Enter (US)
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Authentication successful');
      const state = harness.stateJsonFile.asJson() as {
        auth: { connections: Array<{ region: string }> };
      };
      expect(state.auth.connections[0].region).toBe('us');
    },
    { timeout: 15000 },
  );

  it(
    'prompts for server, region, and org when all are unspecified',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('my-token')
        .withOrganizations([
          { key: 'my-org', name: 'My Org' },
          { key: 'my-org-2', name: 'My Org 2' },
        ])
        .start();

      const result = await harness.run('auth login', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl(),
          SONARQUBE_CLI_SONARCLOUD_API_URL: server.baseUrl(),
        },
        browserToken: 'my-token',
        stdinChunks: ['\r', '\r', '\x1b[B\r'], // Enter (Cloud), Enter (EU), down+Enter (org 2)
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        `Authentication successful for: ${server.baseUrl()} (my-org-2)`,
      );
    },
    { timeout: 15000 },
  );

  it(
    'prompts for server and logs in to a self-hosted SonarQube Server',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('my-token').start();

      const result = await harness.run('auth login', {
        browserToken: 'my-token',
        stdinChunks: ['\x1b[B\r', `${server.baseUrl()}\r`], // down+Enter (Server), URL+Enter
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Authentication successful');
      const state = harness.stateJsonFile.asJson() as {
        auth: { connections: Array<{ serverUrl: string; type: string }> };
      };
      expect(state.auth.connections[0].serverUrl).toBe(server.baseUrl());
      expect(state.auth.connections[0].type).toBe('on-premise');
    },
    { timeout: 15000 },
  );

  it(
    'retries when self-hosted URL is blank and succeeds on valid input',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('my-token').start();

      const result = await harness.run('auth login', {
        browserToken: 'my-token',
        stdinChunks: ['\x1b[B\r', '\r', `${server.baseUrl()}\r`], // Server, blank, valid URL
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        'Please enter a valid URL (for example https://sonarqube.mycompany.com/sonarqube).',
      );
      expect(result.stdout).toContain('Authentication successful');
    },
    { timeout: 15000 },
  );

  it(
    'retries when self-hosted URL is invalid and succeeds on valid input',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('my-token').start();

      const result = await harness.run('auth login', {
        browserToken: 'my-token',
        stdinChunks: ['\x1b[B\r', 'not-a-url\r', `${server.baseUrl()}\r`], // Server, invalid, valid URL
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        'Please enter a valid URL (for example https://sonarqube.mycompany.com/sonarqube).',
      );
      expect(result.stdout).toContain('Authentication successful');
    },
    { timeout: 15000 },
  );

  it(
    'shows the error message for each invalid URL attempt before succeeding',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('my-token').start();

      const result = await harness.run('auth login', {
        browserToken: 'my-token',
        stdinChunks: [
          '\x1b[B\r', // down+Enter (Server)
          'bad-url-1\r', // invalid attempt 1
          'bad-url-2\r', // invalid attempt 2
          'bad-url-3\r', // invalid attempt 3
          `${server.baseUrl()}\r`, // valid URL
        ],
      });

      expect(result.exitCode).toBe(0);
      const errorMsg =
        'Please enter a valid URL (for example https://sonarqube.mycompany.com/sonarqube).';
      const occurrences = result.stdout.split(errorMsg).length - 1;
      expect(occurrences).toBe(3);
      expect(result.stdout).toContain('Authentication successful');
    },
    { timeout: 15000 },
  );

  it(
    'exits with error when user cancels the server selection prompt',
    async () => {
      const result = await harness.run('auth login', {
        stdin: '\x03', // Ctrl+C
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Server selection cancelled');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 when --with-token is provided but --server is not',
    async () => {
      const result = await harness.run('auth login --with-token my-token');

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--server is required when --with-token is provided');
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
        .withTokenName('cli-logout-token')
        .withKeychainToken(server.baseUrl(), 'logout-token');

      const result = await harness.run(`auth logout`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Logged out from: ${server.baseUrl()}`);

      const revokeRequest = server
        .getRecordedRequests()
        .find((request) => request.path === '/api/user_tokens/revoke');
      expect(revokeRequest?.method).toBe('POST');
      expect(revokeRequest?.body).toBe('name=cli-logout-token');

      const account = generateKeychainAccount(server.baseUrl());
      expect(readKeychainToken(harness.keychainJsonFile, account)).toBeUndefined();
      const authState = harness.stateJsonFile.asJson().auth as {
        connections: unknown[];
        activeConnectionId: string | undefined;
        isAuthenticated: boolean;
      };
      expect(authState.connections).toHaveLength(0);
      expect(authState.activeConnectionId).toBeUndefined();
      expect(authState.isAuthenticated).toBe(false);
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
      expect(result.stderr).toContain(
        'The server-side token name is unknown for this connection, so the token could not be revoked automatically. Revoke it manually on the server if needed.',
      );
      expect(result.stdout).toContain(`Logged out from: ${server.baseUrl()}`);
      const authState = harness.stateJsonFile.asJson().auth as {
        connections: unknown[];
        activeConnectionId: string | undefined;
        isAuthenticated: boolean;
      };
      expect(authState.connections).toHaveLength(0);
      expect(authState.activeConnectionId).toBeUndefined();
      expect(authState.isAuthenticated).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'warns and skips revocation when tokenName is known but the keychain has no token',
    async () => {
      const server = await harness.newFakeServer().start();
      harness.state().withActiveConnection(server.baseUrl()).withTokenName('cli-browser-token');

      const result = await harness.run(`auth logout`);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        'Could not retrieve the local token from the keychain, so the server-side token "cli-browser-token" could not be revoked automatically. Revoke it manually on the server if needed.',
      );
      // No revoke call should have been issued: we have no token to authenticate it.
      const revokeRequest = server
        .getRecordedRequests()
        .find((request) => request.path === '/api/user_tokens/revoke');
      expect(revokeRequest).toBeUndefined();
      expect(result.stdout).toContain(`Logged out from: ${server.baseUrl()}`);
      expect(harness.stateJsonFile.asJson().auth.activeConnectionId).toBeUndefined();
      expect(harness.stateJsonFile.asJson().auth.isAuthenticated).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'warns and still completes local cleanup when token revocation fails',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('logout-token')
        .withTokenRevocationFailure(500, 'revocation boom')
        .start();

      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withTokenName('cli-logout-token')
        .withKeychainToken(server.baseUrl(), 'logout-token');

      const result = await harness.run('auth logout');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        'Failed to revoke the server-side token "cli-logout-token": SonarQube API error: 500 Internal Server Error - revocation boom. Continuing with local logout.',
      );
      expect(result.stdout).toContain(`Logged out from: ${server.baseUrl()}`);

      const account = generateKeychainAccount(server.baseUrl());
      expect(readKeychainToken(harness.keychainJsonFile, account)).toBeUndefined();
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
    'removes all tokens after confirmation and clears auth state',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('purge-token-1').start();

      const server2 = await harness.newFakeServer().withAuthToken('purge-token-2').start();

      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'purge-token-1')
        .withKeychainToken(server2.baseUrl(), 'purge-token-2');

      const result = await harness.run('auth purge', { stdin: 'y\n' });

      expect(result.exitCode).toBe(0);

      const account1 = generateKeychainAccount(server.baseUrl());
      const account2 = generateKeychainAccount(server2.baseUrl());
      expect(readKeychainToken(harness.keychainJsonFile, account1)).toBeUndefined();
      expect(readKeychainToken(harness.keychainJsonFile, account2)).toBeUndefined();

      const authState = harness.stateJsonFile.asJson().auth as {
        connections: unknown[];
        activeConnectionId: string | undefined;
        isAuthenticated: boolean;
      };
      expect(authState.connections).toHaveLength(0);
      expect(authState.activeConnectionId).toBeUndefined();
      expect(authState.isAuthenticated).toBe(false);
    },
    { timeout: 15000 },
  );
});

const HTTP_503_SERVICE_UNAVAILABLE = 503;

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
        .withSystemStatusCode(HTTP_503_SERVICE_UNAVAILABLE)
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

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('No saved connection');
      expect(result.stderr).toContain('Authentication check failed.');
      expect(result.stderr).toContain("💡 Run 'sonar auth login' to authenticate.");
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

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Token missing');
      expect(result.stderr).toContain('Authentication check failed.');
      expect(result.stderr).toContain("💡 Run 'sonar auth login' to restore the token.");
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
      expect(result.stdout).toContain(
        `[✓ Connected]\nServer  ${server.baseUrl()}\nSource  OS Keychain`,
      );
    },
    { timeout: 15000 },
  );

  it(
    'reports connected when SQS credentials are set via environment variables',
    async () => {
      const result = await harness.run('auth status', {
        extraEnv: {
          [ENV_TOKEN]: 'env-token',
          [ENV_SERVER]: 'http://my-sonarqube.example.com',
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        `[✓ Connected]\nServer  http://my-sonarqube.example.com\nSource  env vars:  ${ENV_TOKEN}, ${ENV_SERVER}`,
      );
    },
    { timeout: 15000 },
  );

  it(
    'reports connected when SQC credentials are set via environment variables',
    async () => {
      const result = await harness.run('auth status', {
        extraEnv: {
          [ENV_TOKEN]: 'env-token',
          [ENV_ORG]: 'my-org',
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        `[✓ Connected]\nServer  ${SONARCLOUD_URL}\nOrg     my-org\nSource  env vars:  ${ENV_TOKEN}, ${ENV_ORG}`,
      );
    },
    { timeout: 15000 },
  );

  it(
    'reports connected when SQC US credentials are set via environment variables',
    async () => {
      const result = await harness.run('auth status', {
        extraEnv: {
          [ENV_TOKEN]: 'env-token',
          [ENV_ORG]: 'my-org',
          [ENV_SERVER]: SONARCLOUD_US_URL,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        `[✓ Connected]\nServer  ${SONARCLOUD_US_URL}\nOrg     my-org\nSource  env vars:  ${ENV_TOKEN}, ${ENV_ORG}, ${ENV_SERVER}`,
      );
    },
    { timeout: 15000 },
  );

  it(
    'reports token invalid when server rejects the token',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('valid-token').start();

      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'wrong-token');

      const result = await harness.run('auth status');

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Token invalid');
      expect(result.stderr).toContain('Authentication check failed.');
      expect(result.stderr).toContain("💡 Run 'sonar auth login' to reauthenticate.");
    },
    { timeout: 15000 },
  );

  it(
    'reports cannot reach server when server is not running',
    async () => {
      const server = await harness.newFakeServer().start();
      const baseUrl = server.baseUrl();
      await server.stop();

      harness.state().withActiveConnection(baseUrl).withKeychainToken(baseUrl, 'any-token');

      const result = await harness.run('auth status');

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Cannot reach server');
      expect(result.stderr).toContain('Connection check failed.');
      expect(result.stderr).toContain(
        '💡 Check the server URL and network connectivity, then retry.',
      );
    },
    { timeout: 15000 },
  );
});
