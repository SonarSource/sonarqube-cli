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

// Integration tests for `sonar import`

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

const GITHUB_ALM = {
  key: 'github',
  url: 'https://github.com/my-org',
  personal: false,
  membersSync: false,
};
const ADMIN_ACTIONS = { admin: true };

describe('sonar import', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 and prompts to authenticate when no auth is configured',
    async () => {
      const result = await harness.run('import');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('Not authenticated');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when connected to SonarQube Server (not Cloud)',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run('import');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('only supported on SonarQube Cloud');
    },
    { timeout: 15000 },
  );

  describe('organization selection', () => {
    it(
      'prompts to select org even when only one eligible org exists',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizations([
            { key: 'my-org', name: 'My Organization', alm: GITHUB_ALM, actions: ADMIN_ACTIONS },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import', {
          stdin: '\r', // enter → selects the only option
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('my-org');
      },
      { timeout: 15000 },
    );

    it(
      'filters out orgs with no DevOps platform and prompts with the remaining one',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizations([
            {
              key: 'org-configured',
              name: 'Configured Org',
              alm: GITHUB_ALM,
              actions: ADMIN_ACTIONS,
            },
            { key: 'org-empty', name: 'Empty Org' },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import', {
          stdin: '\r', // enter → selects the only eligible option
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('org-configured');
        expect(result.stdout).not.toContain('org-empty');
      },
      { timeout: 15000 },
    );

    it(
      'prompts to select org when multiple orgs have a DevOps platform configured',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizations([
            { key: 'org-one', name: 'Organization One', alm: GITHUB_ALM, actions: ADMIN_ACTIONS },
            { key: 'org-two', name: 'Organization Two', alm: GITHUB_ALM, actions: ADMIN_ACTIONS },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import', {
          stdin: '\x1b[B\r', // down arrow then enter → selects second org
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('org-two');
      },
      { timeout: 15000 },
    );

    it(
      'uses --org flag and skips the org lookup entirely',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizations([
            { key: 'org-one', name: 'Organization One', alm: GITHUB_ALM, actions: ADMIN_ACTIONS },
            { key: 'org-two', name: 'Organization Two', alm: GITHUB_ALM, actions: ADMIN_ACTIONS },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org org-two', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('org-two');
        const recorded = server.getRecordedRequests();
        expect(recorded.some((r) => r.path === '/api/organizations/search')).toBe(false);
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 2 when --non-interactive is set without --org',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('test-token').start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --non-interactive', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(2);
        const output = result.stdout + result.stderr;
        expect(output).toContain('--org is required in non-interactive mode');
      },
      { timeout: 15000 },
    );

    it(
      'succeeds with --non-interactive when --org is provided',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('test-token').start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --non-interactive --org my-org', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('my-org');
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 1 when no organizations have a DevOps platform configured',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizations([{ key: 'my-org', name: 'My Organization' }])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('No eligible organizations found');
      },
      { timeout: 15000 },
    );

    it(
      'shows a "Load more..." option when more than 10 eligible orgs exist and advances when selected',
      async () => {
        const manyOrgs = Array.from({ length: 11 }, (_, i) => ({
          key: `org-${String(i + 1).padStart(2, '0')}`,
          name: `Organization ${i + 1}`,
          alm: GITHUB_ALM,
          actions: ADMIN_ACTIONS,
        }));

        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizations(manyOrgs)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        // navigate to "Load more...", select it, then pick the 11th org that appears
        const result = await harness.run('import', {
          stdinChunks: ['\x1b[B'.repeat(10) + '\r', '\x1b[B'.repeat(10) + '\r'],
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('org-11');
      },
      { timeout: 15000 },
    );

    it(
      'selects an org whose key collides with the load-more sentinel string',
      async () => {
        const manyOrgs = [
          {
            key: '__load_more__',
            name: 'Sentinel-named Org',
            alm: GITHUB_ALM,
            actions: ADMIN_ACTIONS,
          },
          ...Array.from({ length: 10 }, (_, i) => ({
            key: `org-${String(i + 1).padStart(2, '0')}`,
            name: `Organization ${i + 1}`,
            alm: GITHUB_ALM,
            actions: ADMIN_ACTIONS,
          })),
        ];

        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizations(manyOrgs)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        // first visible option is the org whose key equals the internal sentinel string
        const result = await harness.run('import', {
          stdin: '\r',
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('__load_more__');
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 1 when the user is not an admin of any bound organization',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizations([
            { key: 'my-org', name: 'My Organization', alm: GITHUB_ALM, actions: { admin: false } },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('No eligible organizations found');
      },
      { timeout: 15000 },
    );
  });
});
