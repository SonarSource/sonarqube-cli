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
          stdinChunks: ['\r', '\r'], // enter → selects the only org, enter → selects the only repo
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
          stdinChunks: ['\r', '\r'], // enter → selects the only eligible org, enter → selects the only repo
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
          stdinChunks: ['\x1b[B\r', '\r'], // down arrow + enter → selects second org, enter → selects the only repo
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
          stdinChunks: ['\x1b[B'.repeat(10) + '\r', '\x1b[B'.repeat(10) + '\r', '\r'],
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
          stdinChunks: ['\r', '\r'], // enter → selects the sentinel-keyed org, enter → selects the only repo
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
          stdin: '\r', // enter → selects the only repo
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
          stdin: '\x1b[B\r', // down arrow then enter → selects second repo
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
      'exits with code 2 when --non-interactive is set without --repo',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('test-token').start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'test-token');

        const result = await harness.run('import --non-interactive --org my-org', {
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(2);
        const output = result.stdout + result.stderr;
        expect(output).toContain('--repo is required in non-interactive mode');
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
      'excludes repos already imported into the current org from the select list',
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
          stdin: '\r',
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).not.toContain('kevinmlsilva/repo -');
        expect(result.stdout).toContain('kevinmlsilva/other-repo - public');
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
      'shows a "Load more..." option when more than 10 repos exist and advances when selected',
      async () => {
        const manyRepos = Array.from({ length: 11 }, (_, i) => ({
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

        // navigate to "Load more...", select it, then pick the 11th repo that appears
        const result = await harness.run('import --org my-org', {
          stdinChunks: ['\x1b[B'.repeat(10) + '\r', '\x1b[B'.repeat(10) + '\r'],
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('kevinmlsilva/repo-11');
      },
      { timeout: 15000 },
    );

    it(
      'fetches only the first server page before showing the initial repo prompt',
      async () => {
        // 60 repos exceeds the 50-item server page cap, so an eager fetch-all
        // would need 2 requests; the lazy loader should only need 1 to fill
        // the first local page (10 items) the user actually sees.
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
          stdin: '\r', // enter → selects the first repo without paging further
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
          stdinChunks: ['\r', '\r'], // enter → selects the only org, enter → selects the only repo
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Project created:');
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
          stdinChunks: ['\r', '\r'],
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
          stdin: '\r', // enter → selects the only repo
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
          stdin: '\r',
          extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: serverUrl },
        });

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('Failed to create project');
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
        expect(result.stdout).toContain('Project created:');
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
          stdin: '\r', // enter → selects the only repo
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
          stdin: '\r', // enter → selects the only remaining (public) repo
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
});
