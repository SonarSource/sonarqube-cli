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
const GITLAB_ALM = {
  key: 'gitlab',
  url: 'https://gitlab.com/my-org',
  personal: false,
  membersSync: false,
};
const ADMIN_ACTIONS = { admin: true };

// `/organizations/organizations` defaults an org's legacy ID to its key
// (see fake-sonarqube-server.ts), so repos are keyed by org key here too.
const SAMPLE_REPOS = [{ id: 'repo-1', name: 'repo', slug: 'kevinmlsilva/repo' }];

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
          .withDopRepositories('my-org', SAMPLE_REPOS)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import', {
          stdinChunks: ['\r', ' \r'], // enter → selects the only org, space+enter → toggles and confirms the only repo
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
          .withDopRepositories('org-configured', SAMPLE_REPOS)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import', {
          stdinChunks: ['\r', ' \r'], // enter → selects the only eligible org, space+enter → toggles and confirms the only repo
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('org-configured');
        // org-empty is filtered out of the select prompt's options, even though it still
        // appears in the raw `/api/organizations/search` response the debug trace logs.
        expect(result.stdout).not.toContain('Empty Org (org-empty)');
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
          .withDopRepositories('org-two', SAMPLE_REPOS)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import', {
          stdinChunks: ['\x1b[B\r', ' \r'], // down arrow + enter → selects second org, space+enter → toggles and confirms the only repo
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('org-two');
      },
      { timeout: 15000 },
    );

    it(
      'uses --org flag and skips listing all member organizations',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizations([
            { key: 'org-one', name: 'Organization One', alm: GITHUB_ALM, actions: ADMIN_ACTIONS },
            { key: 'org-two', name: 'Organization Two', alm: GITHUB_ALM, actions: ADMIN_ACTIONS },
          ])
          .withDopRepositories('org-two', [
            { id: 'repo-1', name: 'some-repo', slug: 'org-two/some-repo' },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org org-two --repo org-two/some-repo', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('org-two');
        const recorded = server.getRecordedRequests();
        // --org still resolves the single org's alm/visibility settings via a targeted
        // lookup, but must never list every organization the user is a member of.
        expect(
          recorded.some((r) => r.path === '/api/organizations/search' && r.query.member === 'true'),
        ).toBe(false);
        expect(
          recorded.some(
            (r) => r.path === '/api/organizations/search' && r.query.organizations === 'org-two',
          ),
        ).toBe(true);
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
      'succeeds with --non-interactive when --org and --repo are provided',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', [
            { id: 'repo-1', name: 'some-repo', slug: 'my-org/some-repo' },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run(
          'import --non-interactive --org my-org --repo my-org/some-repo',
          { extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl } },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('my-org');
        expect(result.stdout).toContain('my-org/some-repo');
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
          .withDopRepositories('org-11', SAMPLE_REPOS)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        // navigate to "Load more...", select it, pick the 11th org, then select the only repo
        const result = await harness.run('import', {
          stdinChunks: ['\x1b[B'.repeat(10) + '\r', '\x1b[B'.repeat(10) + '\r', ' \r'],
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
          .withDopRepositories('__load_more__', SAMPLE_REPOS)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        // first visible option is the org whose key equals the internal sentinel string
        const result = await harness.run('import', {
          stdinChunks: ['\r', ' \r'], // enter → selects the sentinel-keyed org, space+enter → toggles and confirms the only repo
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

    it(
      'exits with code 1 rather than silently disabling visibility rules when the --org lookup fails',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizationsSearchError(500)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org my-org', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain("Failed to look up organization 'my-org'");
      },
      { timeout: 15000 },
    );
  });

  describe('onboarding mode selection', () => {
    it(
      'offers Recommended, Manual, and Back, importing everything eligible when Recommended is chosen',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', [
            { id: 'repo-1', name: 'repo-1', slug: 'my-org/repo-1' },
            { id: 'repo-2', name: 'repo-2', slug: 'my-org/repo-2' },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org my-org', {
          stdin: '\r', // enter → Recommended (the default, first option)
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('How do you want to import repositories?');
        expect(result.stdout).toContain(
          'Recommended — import all eligible repositories automatically',
        );
        expect(result.stdout).toContain('Manual — choose repositories yourself');
        expect(result.stdout).toContain('Imported 2 repositories');
        expect(result.stdout).toContain(
          `Dashboard: ${serverUrl}/organizations/my-org/onboarding-dashboard`,
        );
        const recorded = server.getRecordedRequests();
        const provisionRequests = recorded.filter(
          (r) => r.path === '/api/alm_integration/provision_projects',
        );
        expect(provisionRequests).toHaveLength(2);
      },
      { timeout: 15000 },
    );

    it(
      'omits "← Back" when --org pins the organization',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', [{ id: 'repo-1', name: 'repo-1', slug: 'my-org/repo-1' }])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org my-org', {
          stdin: '\r',
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).not.toContain('← Back');
      },
      { timeout: 15000 },
    );

    it(
      '"← Back" returns to organization selection and re-resolves the newly chosen org',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizations([
            { key: 'org-one', name: 'Organization One', alm: GITHUB_ALM, actions: ADMIN_ACTIONS },
            { key: 'org-two', name: 'Organization Two', alm: GITHUB_ALM, actions: ADMIN_ACTIONS },
          ])
          .withDopRepositories('org-one', [
            { id: 'repo-1', name: 'repo-one', slug: 'org-one/repo-one' },
          ])
          .withDopRepositories('org-two', [
            { id: 'repo-2', name: 'repo-two', slug: 'org-two/repo-two' },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        // enter → picks org-one; down+down+enter → "← Back" (3rd option after
        // Recommended/Manual); down+enter → picks org-two this time; enter → Recommended
        // mode for org-two (its only repo is eligible either way).
        const result = await harness.run('import', {
          stdinChunks: ['\r', '\x1b[B\x1b[B\r', '\x1b[B\r', '\r'],
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('org-two');
        expect(result.stdout).toContain('org-two/repo-two');
        expect(result.stdout).not.toContain('org-one/repo-one');
        const recorded = server.getRecordedRequests();
        const provisionRequests = recorded.filter(
          (r) => r.path === '/api/alm_integration/provision_projects',
        );
        expect(provisionRequests).toHaveLength(1);
        expect(new URLSearchParams(provisionRequests[0].body ?? '').get('installationKeys')).toBe(
          'org-two/repo-two|repo-2',
        );
      },
      { timeout: 15000 },
    );

    it(
      'cancelling the Manual picker returns to the Recommended/Manual/Back menu',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', [
            { id: 'repo-1', name: 'repo-1', slug: 'my-org/repo-1' },
            { id: 'repo-2', name: 'repo-2', slug: 'my-org/repo-2' },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        // down+enter → Manual mode; 'q' → cancel the picker, back to the mode menu; enter →
        // Recommended this time (the re-shown menu's default, first option).
        const result = await harness.run('import --org my-org', {
          stdinChunks: ['\x1b[B\r', 'q', '\r'],
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        // The picker is cancelled (not treated as an error) and the mode menu re-appears,
        // this time resolving to Recommended instead of Manual.
        expect(result.stdout).toContain('✗  Select repositories to import');
        expect(result.stdout).toContain(
          '✓  How do you want to import repositories? Recommended — import all eligible repositories automatically',
        );
        expect(result.stdout).toContain('Imported 2 repositories');
        const recorded = server.getRecordedRequests();
        const provisionRequests = recorded.filter(
          (r) => r.path === '/api/alm_integration/provision_projects',
        );
        expect(provisionRequests).toHaveLength(2);
      },
      { timeout: 15000 },
    );

    it(
      'offers to go back when the interactively-picked org has nothing eligible to import',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizations([
            { key: 'org-one', name: 'Organization One', alm: GITHUB_ALM, actions: ADMIN_ACTIONS },
            { key: 'org-two', name: 'Organization Two', alm: GITHUB_ALM, actions: ADMIN_ACTIONS },
          ])
          .withDopRepositories('org-one', [
            {
              id: 'repo-1',
              name: 'repo-one',
              slug: 'org-one/repo-one',
              importedInCurrentOrg: true,
            },
          ])
          .withDopRepositories('org-two', [
            { id: 'repo-2', name: 'repo-two', slug: 'org-two/repo-two' },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        // enter → picks org-one (nothing eligible); enter → accepts the default "Yes, go
        // back"; down+enter → picks org-two this time; enter → Recommended mode for org-two.
        const result = await harness.run('import', {
          stdinChunks: ['\r', '\r', '\x1b[B\r', '\r'],
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        const output = result.stdout + result.stderr;
        expect(output).toContain(
          'All repositories for the selected organization have already been imported into SonarQube.',
        );
        expect(output).toContain('Go back and choose a different organization?');
        expect(result.stdout).toContain('org-two/repo-two');
        const recorded = server.getRecordedRequests();
        const provisionRequests = recorded.filter(
          (r) => r.path === '/api/alm_integration/provision_projects',
        );
        expect(provisionRequests).toHaveLength(1);
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 1 when declining to go back after nothing is eligible',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizations([
            { key: 'org-one', name: 'Organization One', alm: GITHUB_ALM, actions: ADMIN_ACTIONS },
          ])
          .withDopRepositories('org-one', [
            {
              id: 'repo-1',
              name: 'repo-one',
              slug: 'org-one/repo-one',
              importedInCurrentOrg: true,
            },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        // enter → picks the only org; 'n' → declines going back
        const result = await harness.run('import', {
          stdinChunks: ['\r', 'n'],
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain(
          'All repositories for the selected organization have already been imported into SonarQube.',
        );
      },
      { timeout: 15000 },
    );
  });

  describe('repository selection', () => {
    it(
      'prompts to select repo even when only one repo exists',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', SAMPLE_REPOS)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org my-org', {
          stdinChunks: ['\x1b[B\r', ' \r'], // down arrow+enter → Manual mode, space+enter → toggles and confirms the only repo
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('kevinmlsilva/repo');
      },
      { timeout: 15000 },
    );

    it(
      'prompts to select repo when multiple repos exist',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', [
            { id: 'repo-1', name: 'repo-one', slug: 'kevinmlsilva/repo-one' },
            { id: 'repo-2', name: 'repo-two', slug: 'kevinmlsilva/repo-two' },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org my-org', {
          // down arrow+enter → Manual mode, down arrow+space+enter → toggles and confirms second repo
          stdinChunks: ['\x1b[B\r', '\x1b[B \r'],
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('kevinmlsilva/repo-two');
      },
      { timeout: 15000 },
    );

    it(
      'uses --repo flag directly, skipping the select prompt but still resolving its installation key',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', [
            ...SAMPLE_REPOS,
            { id: 'repo-2', name: 'other-repo', slug: 'kevinmlsilva/other-repo' },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org my-org --repo kevinmlsilva/other-repo', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('kevinmlsilva/other-repo');
        const recorded = server.getRecordedRequests();
        const repoRequests = recorded.filter((r) => r.path === '/dop-translation/dop-repositories');
        expect(repoRequests).toHaveLength(1);
      },
      { timeout: 15000 },
    );

    it(
      'paginates --repo resolution until every slug is found, across multiple server pages',
      async () => {
        // 60 repos exceeds the 50-item server page cap: repo-1 is on the first page, repo-51
        // only appears on the second — resolving both requires exactly 2 pages, proving
        // pagination continues until every requested slug is matched.
        const manyRepos = Array.from({ length: 60 }, (_, i) => ({
          id: `repo-${i + 1}`,
          name: `repo-${i + 1}`,
          slug: `my-org/repo-${i + 1}`,
        }));

        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', manyRepos)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run(
          'import --non-interactive --org my-org --repo my-org/repo-1,my-org/repo-51',
          { extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl } },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Imported 2 repositories');
        const recorded = server.getRecordedRequests();
        const repoRequests = recorded.filter((r) => r.path === '/dop-translation/dop-repositories');
        expect(repoRequests).toHaveLength(2);
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 2 when --non-interactive is set without --repo or --all',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('test-token').start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --non-interactive --org my-org', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(2);
        const output = result.stdout + result.stderr;
        expect(output).toContain('--repo or --all is required in non-interactive mode');
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 1 when no repositories are found for the selected organization',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('test-token').start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org my-org', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('No repositories found for the selected organization');
      },
      { timeout: 15000 },
    );

    it(
      'lists repos already imported into the current org as non-toggleable in the select list',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', [
            { id: 'repo-1', name: 'repo', slug: 'kevinmlsilva/repo', importedInCurrentOrg: true },
            { id: 'repo-2', name: 'other-repo', slug: 'kevinmlsilva/other-repo' },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org my-org', {
          stdinChunks: [
            '\x1b[B\r', // down arrow+enter → Manual mode
            // toggle the eligible repo (cursor starts on it), move down to the already-imported
            // row, attempt to toggle it too (must be a no-op), then confirm.
            ' \x1b[B \r',
          ],
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        // The already-imported repo is listed (dimmed/non-toggleable), not hidden.
        expect(result.stdout).toContain('kevinmlsilva/repo - public (already imported)');
        expect(result.stdout).toContain('kevinmlsilva/other-repo - public');
        expect(result.stdout).toContain('1 of 1 selected');
        expect(result.stdout).toContain('Imported 1 repository');

        const provisionRequests = server
          .getRecordedRequests()
          .filter((r) => r.path === '/api/alm_integration/provision_projects');
        expect(provisionRequests).toHaveLength(1);
        expect(new URLSearchParams(provisionRequests[0].body ?? '').get('installationKeys')).toBe(
          'repo-2',
        );
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 1 when every repository is already imported',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', [
            { id: 'repo-1', name: 'repo', slug: 'kevinmlsilva/repo', importedInCurrentOrg: true },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org my-org', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('already been imported into SonarQube');
      },
      { timeout: 15000 },
    );

    it(
      'shows a "Load more..." option after a full first page and fetches the next page when selected',
      async () => {
        // 51 repos exceeds the 50-item server page cap, so the first page is fetched (and
        // shown) without ever touching the 51st repo — "Load more" only fetches page two when
        // actually selected.
        const manyRepos = Array.from({ length: 51 }, (_, i) => ({
          id: `repo-${i + 1}`,
          name: `repo-${String(i + 1).padStart(2, '0')}`,
          slug: `kevinmlsilva/repo-${String(i + 1).padStart(2, '0')}`,
        }));

        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', manyRepos)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        // down arrow+enter → Manual mode, then navigate to "Load more..." (50 repos precede it
        // on the first page), select it — which fetches page two — then toggle and confirm the
        // newly revealed 51st repo (cursor carries over onto it, since the multi-select prompt
        // never resets its cursor).
        const result = await harness.run('import --org my-org', {
          stdinChunks: ['\x1b[B\r', '\x1b[B'.repeat(50) + '\r', ' \r'],
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
          timeoutMs: 20000,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('kevinmlsilva/repo-51');
        const recorded = server.getRecordedRequests();
        const repoRequests = recorded.filter((r) => r.path === '/dop-translation/dop-repositories');
        expect(repoRequests).toHaveLength(2);
      },
      { timeout: 20000 },
    );

    it(
      'does not fetch further server pages until "Load more" is actually selected',
      async () => {
        // 60 repos exceeds the 50-item server page cap, but picking a repo from the first page
        // should never trigger a second page fetch.
        const manyRepos = Array.from({ length: 60 }, (_, i) => ({
          id: `repo-${i + 1}`,
          name: `repo-${String(i + 1).padStart(2, '0')}`,
          slug: `kevinmlsilva/repo-${String(i + 1).padStart(2, '0')}`,
        }));

        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', manyRepos)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org my-org', {
          // down arrow+enter → Manual mode, space+enter → toggles and confirms the first repo
          stdinChunks: ['\x1b[B\r', ' \r'],
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('kevinmlsilva/repo-01');
        const recorded = server.getRecordedRequests();
        const repoRequests = recorded.filter((r) => r.path === '/dop-translation/dop-repositories');
        expect(repoRequests).toHaveLength(1);
      },
      { timeout: 15000 },
    );

    it(
      'shows every selectable repo from a single server page alongside interleaved already-imported ones',
      async () => {
        // 15 raw repos easily fit in one 50-item server page; 5 of the first 10 are already
        // imported. Filtering happens per fetched page, so all 10 selectable repos from this
        // one page show up together, with no "Load more" needed. The already-imported ones are
        // still listed (non-toggleable), not hidden.
        const manyRepos = Array.from({ length: 15 }, (_, i) => ({
          id: `repo-${i + 1}`,
          name: `repo-${String(i + 1).padStart(2, '0')}`,
          slug: `kevinmlsilva/repo-${String(i + 1).padStart(2, '0')}`,
          importedInCurrentOrg: i < 10 && i % 2 === 0, // repo-01,03,05,07,09 already imported
        }));

        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', manyRepos)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org my-org', {
          // down arrow+enter → Manual mode, space+enter → toggles and confirms the first selectable repo
          stdinChunks: ['\x1b[B\r', ' \r'],
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        // Exactly the 10 selectable repos (02,04,06,08,10,11-15), no "Load more" needed.
        for (const slug of [
          'kevinmlsilva/repo-02',
          'kevinmlsilva/repo-04',
          'kevinmlsilva/repo-06',
          'kevinmlsilva/repo-08',
          'kevinmlsilva/repo-10',
          'kevinmlsilva/repo-11',
          'kevinmlsilva/repo-12',
          'kevinmlsilva/repo-13',
          'kevinmlsilva/repo-14',
          'kevinmlsilva/repo-15',
        ]) {
          expect(result.stdout).toContain(slug);
        }
        expect(result.stdout).toContain('kevinmlsilva/repo-01 - public (already imported)');
        expect(result.stdout).not.toContain('Load more');
        expect(result.stdout).toContain('Imported 1 repository');
      },
      { timeout: 15000 },
    );

    it(
      'does not cap Manual selection — every eligible repo on the page can be selected',
      async () => {
        const manyRepos = Array.from({ length: 26 }, (_, i) => ({
          id: `repo-${i + 1}`,
          name: `repo-${i + 1}`,
          slug: `my-org/repo-${i + 1}`,
        }));

        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', manyRepos)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        // down arrow+enter → Manual mode; toggle the first repo, then (down+toggle) 25 more
        // times — 26 toggle attempts across all 26 repos, all of which must be accepted.
        const result = await harness.run('import --org my-org', {
          stdinChunks: ['\x1b[B\r', ' ' + '\x1b[B '.repeat(25) + '\r'],
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
          timeoutMs: 20000,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('26 of 26 selected');
        expect(result.stdout).toContain('Imported 26 repositories');
        const recorded = server.getRecordedRequests();
        const provisionRequests = recorded.filter(
          (r) => r.path === '/api/alm_integration/provision_projects',
        );
        expect(provisionRequests).toHaveLength(26);
        const installationKeys = provisionRequests.map((r) =>
          new URLSearchParams(r.body ?? '').get('installationKeys'),
        );
        expect(installationKeys).toContain('repo-26');
      },
      { timeout: 20000 },
    );
  });

  describe('project provisioning', () => {
    it(
      'creates the project and prints its key after selecting org and repo interactively',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizations([
            { key: 'my-org', name: 'My Organization', alm: GITHUB_ALM, actions: ADMIN_ACTIONS },
          ])
          .withDopRepositories('my-org', SAMPLE_REPOS)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import', {
          // enter → selects the only org, down arrow+enter → Manual mode,
          // space+enter → toggles and confirms the only repo
          stdinChunks: ['\r', '\x1b[B\r', ' \r'],
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Imported 1 repository');
        const recorded = server.getRecordedRequests();
        const provisionRequest = recorded.find(
          (r) => r.path === '/api/alm_integration/provision_projects',
        );
        const params = new URLSearchParams(provisionRequest?.body ?? '');
        expect(params.get('organization')).toBe('my-org');
        // GitHub installation keys are formatted as `<slug>|<id>`.
        expect(params.get('installationKeys')).toBe('kevinmlsilva/repo|repo-1');
      },
      { timeout: 15000 },
    );

    it(
      'sends the plain repo id as installationKeys for non-GitHub organizations',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizations([
            { key: 'my-org', name: 'My Organization', alm: GITLAB_ALM, actions: ADMIN_ACTIONS },
          ])
          .withDopRepositories('my-org', SAMPLE_REPOS)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import', {
          stdinChunks: ['\r', '\x1b[B\r', ' \r'],
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        const recorded = server.getRecordedRequests();
        const provisionRequest = recorded.find(
          (r) => r.path === '/api/alm_integration/provision_projects',
        );
        const params = new URLSearchParams(provisionRequest?.body ?? '');
        expect(params.get('installationKeys')).toBe('repo-1');
      },
      { timeout: 15000 },
    );

    it(
      'resolves the ALM type from the targeted org lookup when --org is passed directly',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizations([
            { key: 'my-org', name: 'My Organization', alm: GITHUB_ALM, actions: ADMIN_ACTIONS },
          ])
          .withDopRepositories('my-org', SAMPLE_REPOS)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org my-org', {
          // down arrow+enter → Manual mode, space+enter → toggles and confirms the only repo
          stdinChunks: ['\x1b[B\r', ' \r'],
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        const recorded = server.getRecordedRequests();
        // The org's alm.key comes back on the targeted `--org` lookup itself, so the
        // organization-bindings fallback (used when the alm key isn't already known)
        // should never be hit.
        expect(recorded.some((r) => r.path === '/dop-translation/organization-bindings')).toBe(
          false,
        );
        const provisionRequest = recorded.find(
          (r) => r.path === '/api/alm_integration/provision_projects',
        );
        const params = new URLSearchParams(provisionRequest?.body ?? '');
        expect(params.get('installationKeys')).toBe('kevinmlsilva/repo|repo-1');
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 1 when provisioning fails',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', SAMPLE_REPOS)
          .withProvisionProjectsError(
            400,
            JSON.stringify({ errors: [{ msg: 'Repository already imported' }] }),
          )
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org my-org', {
          stdinChunks: ['\x1b[B\r', ' \r'], // down arrow+enter → Manual mode, space+enter → toggles and confirms the only repo
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('Failed to import 1 repository.');
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 1 when --repo does not match any repository in the DevOps platform',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', SAMPLE_REPOS)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org my-org --repo kevinmlsilva/does-not-exist', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain("not found in the selected organization's DevOps platform");
      },
      { timeout: 15000 },
    );

    it(
      'rejects --repo for a private repo when onlyPrivateProjects is unavailable',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizations([
            {
              key: 'my-org',
              name: 'My Organization',
              alm: GITHUB_ALM,
              actions: ADMIN_ACTIONS,
              onlyPrivateProjects: { enabled: false },
            },
          ])
          .withDopRepositories('my-org', [
            { id: 'repo-1', name: 'repo', slug: 'kevinmlsilva/repo', private: true },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --repo kevinmlsilva/repo', {
          stdin: '\r', // enter → selects the only org
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain(
          "isn't allowed by this organization's project visibility settings",
        );
      },
      { timeout: 15000 },
    );

    it(
      'allows --repo for a private repo when onlyPrivateProjects requires private-only',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizations([
            {
              key: 'my-org',
              name: 'My Organization',
              alm: GITHUB_ALM,
              actions: ADMIN_ACTIONS,
              onlyPrivateProjects: { enabled: true },
            },
          ])
          .withPrivateProjectsEntitlement('my-org', true)
          .withDopRepositories('my-org', [
            { id: 'repo-1', name: 'repo', slug: 'kevinmlsilva/repo', private: true },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --repo kevinmlsilva/repo', {
          stdin: '\r', // enter → selects the only org
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Imported 1 repository');
      },
      { timeout: 15000 },
    );

    it(
      'enforces onlyPrivateProjects for a public repo even when --org skips interactive org selection',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withOrganizations([
            {
              key: 'my-org',
              name: 'My Organization',
              alm: GITHUB_ALM,
              actions: ADMIN_ACTIONS,
              onlyPrivateProjects: { enabled: true },
            },
          ])
          .withPrivateProjectsEntitlement('my-org', true)
          .withDopRepositories('my-org', [
            { id: 'repo-1', name: 'repo', slug: 'kevinmlsilva/repo', private: false },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        // --org my-org resolves the org's onlyPrivateProjects setting via a targeted lookup
        // rather than the interactive listing, and that setting must still be enforced.
        const result = await harness.run('import --org my-org --repo kevinmlsilva/repo', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain(
          "isn't allowed by this organization's project visibility settings",
        );
      },
      { timeout: 15000 },
    );

    it(
      'labels a private repo in the select prompt',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withPrivateProjectsEntitlement('my-org', true)
          .withDopRepositories('my-org', [
            { id: 'repo-1', name: 'repo', slug: 'kevinmlsilva/repo', private: true },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org my-org', {
          // down arrow+enter → Manual mode, space+enter → toggles and confirms the only repo
          stdinChunks: ['\x1b[B\r', ' \r'],
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('kevinmlsilva/repo - private');
      },
      { timeout: 15000 },
    );

    it(
      'filters out repos that fail visibility rules from the interactive select prompt',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', [
            {
              id: 'repo-1',
              name: 'private-repo',
              slug: 'kevinmlsilva/private-repo',
              private: true,
            },
            { id: 'repo-2', name: 'public-repo', slug: 'kevinmlsilva/public-repo', private: false },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        // No private-projects entitlement configured → org is public-only, so the private
        // repo must be dropped from the list rather than merely shown as disabled.
        const result = await harness.run('import --org my-org', {
          // down arrow+enter → Manual mode, space+enter → toggles and confirms the only remaining (public) repo
          stdinChunks: ['\x1b[B\r', ' \r'],
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('kevinmlsilva/public-repo');
        expect(result.stdout).not.toContain('kevinmlsilva/private-repo');
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 1 when no repositories match visibility settings',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', [
            {
              id: 'repo-1',
              name: 'private-repo',
              slug: 'kevinmlsilva/private-repo',
              private: true,
            },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org my-org', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain(
          "No repositories match this organization's project visibility settings.",
        );
      },
      { timeout: 15000 },
    );
  });

  describe('batch import', () => {
    const BATCH_REPOS = [
      { id: 'repo-a-id', name: 'repo-a', slug: 'my-org/repo-a' },
      { id: 'repo-b-id', name: 'repo-b', slug: 'my-org/repo-b' },
      { id: 'repo-c-id', name: 'repo-c', slug: 'my-org/repo-c' },
    ];

    it(
      'imports multiple repositories given repeated --repo flags',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', BATCH_REPOS)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run(
          'import --non-interactive --org my-org --repo my-org/repo-a --repo my-org/repo-b',
          { extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl } },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Imported 2 repositories');
        const recorded = server.getRecordedRequests();
        const provisionRequests = recorded.filter(
          (r) => r.path === '/api/alm_integration/provision_projects',
        );
        expect(provisionRequests).toHaveLength(2);
        const installationKeys = provisionRequests.map((r) =>
          new URLSearchParams(r.body ?? '').get('installationKeys'),
        );
        expect(installationKeys.sort()).toEqual(['repo-a-id', 'repo-b-id']);
      },
      { timeout: 15000 },
    );

    it(
      'imports multiple repositories given a comma-separated --repo value',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', BATCH_REPOS)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run(
          'import --non-interactive --org my-org --repo my-org/repo-a,my-org/repo-b',
          { extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl } },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Imported 2 repositories');
        const recorded = server.getRecordedRequests();
        const provisionRequests = recorded.filter(
          (r) => r.path === '/api/alm_integration/provision_projects',
        );
        expect(provisionRequests).toHaveLength(2);
      },
      { timeout: 15000 },
    );

    it(
      'dedupes repos given via a mix of repeated and comma-separated --repo flags',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', BATCH_REPOS)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run(
          'import --non-interactive --org my-org --repo my-org/repo-a,my-org/repo-b --repo my-org/repo-a',
          { extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl } },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Imported 2 repositories');
        const recorded = server.getRecordedRequests();
        const provisionRequests = recorded.filter(
          (r) => r.path === '/api/alm_integration/provision_projects',
        );
        expect(provisionRequests).toHaveLength(2);
      },
      { timeout: 15000 },
    );

    it(
      'imports multiple repositories toggled interactively',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', BATCH_REPOS)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        // down arrow+enter → Manual mode, space (toggle repo-a), down, down,
        // space (toggle repo-c), enter (confirm)
        const result = await harness.run('import --org my-org', {
          stdinChunks: ['\x1b[B\r', ' \x1b[B\x1b[B \r'],
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Imported 2 repositories');
        const recorded = server.getRecordedRequests();
        const provisionRequests = recorded.filter(
          (r) => r.path === '/api/alm_integration/provision_projects',
        );
        expect(provisionRequests).toHaveLength(2);
        const installationKeys = provisionRequests.map((r) =>
          new URLSearchParams(r.body ?? '').get('installationKeys'),
        );
        expect(installationKeys.sort()).toEqual(['repo-a-id', 'repo-c-id']);
      },
      { timeout: 15000 },
    );

    it(
      'reports a partial failure summary when some repos fail to provision',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', BATCH_REPOS)
          .withProvisionProjectsError(
            400,
            JSON.stringify({ errors: [{ msg: 'Repository already imported' }] }),
            { onlyForInstallationKey: 'repo-b-id' },
          )
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run(
          'import --non-interactive --org my-org --repo my-org/repo-a,my-org/repo-b,my-org/repo-c',
          { extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl } },
        );

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('Imported 2 of 3 repositories (1 failed)');
        expect(output).toContain('my-org/repo-a');
        expect(output).toContain('my-org/repo-b');
        expect(output).toContain('my-org/repo-c');
        expect(output).toContain('Repository already imported');
      },
      { timeout: 15000 },
    );

    it(
      'fails fast without provisioning any repo when a --repo slug does not match',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', BATCH_REPOS)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run(
          'import --non-interactive --org my-org --repo my-org/repo-a,my-org/does-not-exist,my-org/repo-c',
          { extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl } },
        );

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain("not found in the selected organization's DevOps platform");
        expect(output).toContain('my-org/does-not-exist');
        expect(output).not.toContain('my-org/repo-a');
        const recorded = server.getRecordedRequests();
        const provisionRequests = recorded.filter(
          (r) => r.path === '/api/alm_integration/provision_projects',
        );
        expect(provisionRequests).toHaveLength(0);
      },
      { timeout: 15000 },
    );

    it(
      'fails fast without provisioning any repo when a single --repo slug is already imported',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', [
            ...BATCH_REPOS.map((repo) =>
              repo.slug === 'my-org/repo-a' ? { ...repo, importedInCurrentOrg: true } : repo,
            ),
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run(
          'import --non-interactive --org my-org --repo my-org/repo-a,my-org/repo-b',
          { extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl } },
        );

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('my-org/repo-a');
        expect(output).toContain('has already been imported into SonarQube');
        const recorded = server.getRecordedRequests();
        const provisionRequests = recorded.filter(
          (r) => r.path === '/api/alm_integration/provision_projects',
        );
        expect(provisionRequests).toHaveLength(0);
      },
      { timeout: 15000 },
    );

    it(
      'fails fast listing every already-imported repo when multiple --repo slugs are already imported',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', [
            ...BATCH_REPOS.map((repo) =>
              repo.slug === 'my-org/repo-a' || repo.slug === 'my-org/repo-b'
                ? { ...repo, importedInCurrentOrg: true }
                : repo,
            ),
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run(
          'import --non-interactive --org my-org --repo my-org/repo-a,my-org/repo-b,my-org/repo-c',
          { extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl } },
        );

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('Repositories have already been imported into SonarQube');
        expect(output).toContain('my-org/repo-a');
        expect(output).toContain('my-org/repo-b');
        const recorded = server.getRecordedRequests();
        const provisionRequests = recorded.filter(
          (r) => r.path === '/api/alm_integration/provision_projects',
        );
        expect(provisionRequests).toHaveLength(0);
      },
      { timeout: 15000 },
    );

    it(
      'caps concurrent provisioning requests at 10',
      async () => {
        const manyRepos = Array.from({ length: 15 }, (_, i) => ({
          id: `repo-${i + 1}`,
          name: `repo-${i + 1}`,
          slug: `my-org/repo-${i + 1}`,
        }));

        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', manyRepos)
          .withProvisionProjectsDelay(50)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const repoFlag = manyRepos.map((r) => r.slug).join(',');
        const result = await harness.run(
          `import --non-interactive --org my-org --repo ${repoFlag}`,
          { extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl }, timeoutMs: 30000 },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Imported 15 repositories');
        const recorded = server.getRecordedRequests();
        const provisionRequests = recorded.filter(
          (r) => r.path === '/api/alm_integration/provision_projects',
        );
        expect(provisionRequests).toHaveLength(15);
        expect(server.getPeakConcurrentProvisionRequests()).toBeLessThanOrEqual(10);
        expect(server.getPeakConcurrentProvisionRequests()).toBeGreaterThanOrEqual(8);
      },
      { timeout: 30000 },
    );
  });

  describe('bulk import (--all)', () => {
    it(
      'imports each server page as it is fetched instead of resolving the whole org first',
      async () => {
        // 60 repos exceeds the 50-item server page cap, so `--all` must fetch page one (50
        // repos), import all of them, then fetch page two (10 repos) and import those too.
        const manyRepos = Array.from({ length: 60 }, (_, i) => ({
          id: `repo-${i + 1}`,
          name: `repo-${i + 1}`,
          slug: `my-org/repo-${i + 1}`,
        }));

        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', manyRepos)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --non-interactive --org my-org --all', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
          timeoutMs: 30000,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Imported 60 repositories');

        const recorded = server.getRecordedRequests();
        const repoPageRequests = recorded.filter(
          (r) => r.path === '/dop-translation/dop-repositories',
        );
        expect(repoPageRequests).toHaveLength(2);

        // Every repo from page one must have been provisioned before page two was ever
        // fetched — proving the job streams page-by-page rather than fetching everything
        // up front and importing it all at the end.
        const secondPageIndex = recorded.indexOf(repoPageRequests[1]);
        const provisionsBeforeSecondPage = recorded
          .slice(0, secondPageIndex)
          .filter((r) => r.path === '/api/alm_integration/provision_projects').length;
        expect(provisionsBeforeSecondPage).toBe(50);
      },
      { timeout: 30000 },
    );

    it(
      'imports every eligible repo and reports skipped counts grouped by reason',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', [
            {
              id: 'repo-1',
              name: 'repo-1',
              slug: 'my-org/already-imported',
              importedInCurrentOrg: true,
            },
            {
              id: 'repo-2',
              name: 'repo-2',
              slug: 'my-org/already-bound',
              boundProjectIds: ['some-other-project'],
            },
            { id: 'repo-3', name: 'repo-3', slug: 'my-org/private-repo', private: true },
            { id: 'repo-4', name: 'repo-4', slug: 'my-org/eligible-a' },
            { id: 'repo-5', name: 'repo-5', slug: 'my-org/eligible-b' },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --non-interactive --org my-org --all', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Imported 2 repositories (3 skipped)');
        expect(result.stdout).toContain('Repositories skipped: 3');
        // Grouped by reason, not listed per repo: 2 already-imported (one flagged directly,
        // one via a non-empty boundProjectIds) + 1 excluded by visibility settings.
        expect(result.stdout).toContain('already imported: 2');
        expect(result.stdout).toContain(
          "private repos aren't allowed by this organization's project visibility settings: 1",
        );
        expect(result.stdout).not.toContain('my-org/already-imported');
        expect(result.stdout).not.toContain('my-org/already-bound');
        expect(result.stdout).not.toContain('my-org/private-repo');

        const recorded = server.getRecordedRequests();
        const provisionRequests = recorded.filter(
          (r) => r.path === '/api/alm_integration/provision_projects',
        );
        expect(provisionRequests).toHaveLength(2);
        const installationKeys = provisionRequests.map((r) =>
          new URLSearchParams(r.body ?? '').get('installationKeys'),
        );
        expect(installationKeys.sort()).toEqual(['repo-4', 'repo-5']);
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 2 when --all is combined with --repo',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', [{ id: 'repo-1', name: 'repo-1', slug: 'my-org/repo-1' }])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --org my-org --all --repo my-org/repo-1', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(2);
        const output = result.stdout + result.stderr;
        expect(output).toContain('--all cannot be combined with --repo');
      },
      { timeout: 15000 },
    );

    it(
      'satisfies --non-interactive without needing --repo',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('test-token').start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --non-interactive --org my-org --all', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        // No repos configured at all — fails for a different reason than the
        // --repo-required validation, proving --all satisfied it.
        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).not.toContain('is required in non-interactive mode');
        expect(output).toContain('No repositories found for the selected organization.');
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 1 when no repos are eligible for import',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopRepositories('my-org', [
            { id: 'repo-1', name: 'repo-1', slug: 'my-org/repo-1', importedInCurrentOrg: true },
            { id: 'repo-2', name: 'repo-2', slug: 'my-org/repo-2', private: true },
          ])
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --non-interactive --org my-org --all', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('No repositories are eligible for import');
      },
      { timeout: 15000 },
    );
  });
});
