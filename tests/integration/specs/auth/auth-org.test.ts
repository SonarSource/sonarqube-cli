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

// Integration tests for `sonar auth org`

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

const STORED_TOKEN = 'stored-token';
const TOKEN_NAME = 'cli-browser-token';

function readKeychainTokens(keychainFile: string): Record<string, string> {
  const store = JSON.parse(readFileSync(keychainFile, 'utf-8')) as {
    tokens: Record<string, string>;
  };
  return store.tokens;
}

describe('auth org', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 and prompts to authenticate when not logged in',
    async () => {
      const result = await harness.run('auth org org-b');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('❌ Not authenticated.');
      expect(output).toContain("  → Run 'sonar auth login' to authenticate.");
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 and points to the environment when environment variable authentication is active',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('env-token').start();

      const result = await harness.run('auth org org-b', {
        extraEnv: {
          SONARQUBE_CLI_TOKEN: 'env-token',
          SONARQUBE_CLI_SERVER: server.baseUrl(),
          SONARQUBE_CLI_ORG: 'org-a',
        },
      });

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('❌ Environment variable authentication is already active.');
      expect(output).toContain('  → Set SONARQUBE_CLI_ORG to the organization you want to use.');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when connected to SonarQube Server (not Cloud)',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('valid-token').start();

      harness.withAuth(server.baseUrl(), 'valid-token');

      const result = await harness.run('auth org org-b');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('Organizations are only applicable to SonarQube Cloud connection.');
    },
    { timeout: 15000 },
  );

  function signInToOrgA(serverUrl: string) {
    harness
      .state()
      .withActiveConnection(serverUrl, 'cloud', 'org-a')
      .withTokenName(TOKEN_NAME)
      .withKeychainToken(serverUrl, STORED_TOKEN);
  }

  function activeConnection() {
    return harness.stateJsonFile.asJson().auth.connections[0] as {
      orgKey?: string;
      tokenName?: string;
      organizationUuidV4?: string;
    };
  }

  function cloudServer() {
    return harness
      .newFakeServer()
      .withAuthToken(STORED_TOKEN)
      .withOrganizations([
        { key: 'org-a', name: 'Org A' },
        { key: 'org-b', name: 'Org B' },
      ]);
  }

  describe('with an explicit organization key', () => {
    it(
      'switches the stored connection to the organization and reports it',
      async () => {
        const server = await cloudServer().start();
        signInToOrgA(server.baseUrl());

        const result = await harness.run('auth org org-b');

        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toContain('Switched to organization: org-b');
        expect(activeConnection().orgKey).toBe('org-b');
      },
      { timeout: 15000 },
    );

    it(
      'keeps the token name and the keychain entry',
      async () => {
        const server = await cloudServer().start();
        signInToOrgA(server.baseUrl());

        const result = await harness.run('auth org org-b');

        expect(result.exitCode).toBe(0);
        expect(activeConnection().tokenName).toBe(TOKEN_NAME);
        expect(Object.values(readKeychainTokens(harness.keychainJsonFile))).toEqual([STORED_TOKEN]);
      },
      { timeout: 15000 },
    );

    it(
      'refreshes the organization identity of the connection',
      async () => {
        const server = await cloudServer().start();
        signInToOrgA(server.baseUrl());

        const result = await harness.run('auth org org-b');

        expect(result.exitCode).toBe(0);
        expect(activeConnection().organizationUuidV4).toBe('org-b-uuid-v4');
      },
      { timeout: 15000 },
    );

    it(
      'makes no change when the organization is already active',
      async () => {
        const server = await cloudServer().start();
        signInToOrgA(server.baseUrl());

        const result = await harness.run('auth org org-a');

        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toContain('Already using organization: org-a');
        expect(activeConnection().orgKey).toBe('org-a');
        expect(activeConnection().organizationUuidV4).toBeUndefined();
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 1 and keeps the active organization when the token is not a member',
      async () => {
        const server = await cloudServer().start();
        signInToOrgA(server.baseUrl());

        const result = await harness.run('auth org org-c');

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain("❌ You are not a member of organization 'org-c'.");
        expect(output).toContain('  → Choose an organization you belong to, then try again.');
        expect(activeConnection().orgKey).toBe('org-a');
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 1 and keeps the active organization when membership cannot be verified',
      async () => {
        const server = await cloudServer().withOrganizationsSearchError(500).start();
        signInToOrgA(server.baseUrl());

        const result = await harness.run('auth org org-b');

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain("❌ Could not verify organization 'org-b'");
        expect(output).not.toContain('not a member');
        expect(output).toContain(
          '  → Check your network connection and the server status, then try again.',
        );
        expect(activeConnection().orgKey).toBe('org-a');
      },
      { timeout: 15000 },
    );
  });

  describe('without an organization key', () => {
    it(
      'switches to the organization chosen from the picker and marks the active one',
      async () => {
        const server = await cloudServer().start();
        signInToOrgA(server.baseUrl());

        const session = harness.runInteractive('auth org');
        await session.waitText('Select an organization');
        session.keyDown();
        session.keyEnter();
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/Org A\s+org-a\s+\S*active/);
        expect(result.stdout).toContain('Switched to organization: org-b');
        expect(activeConnection().orgKey).toBe('org-b');
        expect(activeConnection().tokenName).toBe(TOKEN_NAME);
      },
      { timeout: 15000 },
    );

    it(
      'makes no change when the active organization is chosen',
      async () => {
        const server = await cloudServer().start();
        signInToOrgA(server.baseUrl());

        const session = harness.runInteractive('auth org');
        await session.waitText('Select an organization');
        session.keyEnter();
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Already using organization: org-a');
        expect(activeConnection().orgKey).toBe('org-a');
        expect(activeConnection().organizationUuidV4).toBeUndefined();
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 1 and keeps the active organization when the organizations cannot be listed',
      async () => {
        const server = await cloudServer().withOrganizationsSearchError(500).start();
        signInToOrgA(server.baseUrl());

        const result = await harness.run('auth org');

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('❌ Could not list your organizations');
        expect(output).toContain(
          '  → Check your network connection and the server status, then try again.',
        );
        expect(activeConnection().orgKey).toBe('org-a');
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 1 and keeps the active organization when the selection is cancelled',
      async () => {
        const server = await cloudServer().start();
        signInToOrgA(server.baseUrl());

        const session = harness.runInteractive('auth org');
        await session.waitText('Select an organization');
        session.keyCtrlC();
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Organization selection cancelled');
        expect(activeConnection().orgKey).toBe('org-a');
      },
      { timeout: 15000 },
    );
  });
});
