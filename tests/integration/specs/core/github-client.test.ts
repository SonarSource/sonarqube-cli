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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';
import { GitHubApiError, GitHubClient } from '@/core/github/client.ts';
import { clearNetworkConfigCache } from '@/core/host/connectivity/network-config.ts';
import { clearSecretCache } from '@/core/host/keychain.ts';

import { restoreEnv } from '../../../_common/isolated-cli-env.ts';
import { isolateNetworkEnv } from '../../../_common/network-env.ts';
import { TestHarness } from '../../harness/index.js';

const ORGANIZATION = 'test-org';
const REPO = `${ORGANIZATION}/sample`;
const TOKEN = 'github-token';
const BRANCH = 'sonar/add-sonar-analysis-job';
const WORKFLOW_PATH = '.github/workflows/sonarqube.yml';
const EXISTING_WORKFLOW = 'name: Build\non: push\n';
const FIXTURE = {
  name: 'sample',
  defaultBranch: 'develop',
  files: { '.github/workflows/build.yml': EXISTING_WORKFLOW, 'README.md': '# Sample' },
};

describe('GitHubClient with the fake GitHub server', () => {
  let harness: TestHarness;
  let restoreEnvironment: () => void;

  beforeEach(async () => {
    harness = await TestHarness.create();
    const restoreNetworkEnv = isolateNetworkEnv();
    const previousHome = process.env[ENV_SONAR_USER_HOME];
    const previousKeychain = process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
    process.env[ENV_SONAR_USER_HOME] = harness.sonarUserHome.path;
    process.env.SONARQUBE_CLI_KEYCHAIN_FILE = harness.keychainJsonFile;
    clearSecretCache();
    clearNetworkConfigCache();
    restoreEnvironment = () => {
      clearSecretCache();
      clearNetworkConfigCache();
      restoreNetworkEnv();
      restoreEnv(ENV_SONAR_USER_HOME, previousHome);
      restoreEnv('SONARQUBE_CLI_KEYCHAIN_FILE', previousKeychain);
    };
  });

  afterEach(async () => {
    try {
      await harness.dispose();
    } finally {
      restoreEnvironment();
    }
  });

  const newServer = () =>
    harness.newFakeGitHubServer().withToken(TOKEN).withOrganization(ORGANIZATION, [FIXTURE]);

  it('reads a repository and creates a workflow PR without changing the default branch', async () => {
    const server = await newServer().start();
    const client = new GitHubClient(TOKEN, server.baseUrl());

    const repo = await client.getRepository(REPO);
    expect(repo.default_branch).toBe('develop');
    expect(
      await client.getFileContent(REPO, '.github/workflows/build.yml', repo.default_branch),
    ).toBe(EXISTING_WORKFLOW);
    expect(
      (await client.listRepoTree(REPO, '.github/workflows', repo.default_branch)).map(
        (entry) => entry.name,
      ),
    ).toEqual(['build.yml']);
    const base = await client.getBranch(REPO, repo.default_branch);
    if (!base) throw new Error('Expected a default branch');

    await client.createBranch(REPO, BRANCH, base.object.sha);
    expect((await client.getBranch(REPO, BRANCH))?.object.sha).toBe(base.object.sha);
    const workflow = 'name: SonarQube\n# ünicode\n';
    await client.createFile(REPO, WORKFLOW_PATH, BRANCH, workflow, 'Add SonarQube analysis');
    expect(await client.getFileContent(REPO, WORKFLOW_PATH, BRANCH)).toBe(workflow);
    expect(await client.getFileContent(REPO, WORKFLOW_PATH, repo.default_branch)).toBeNull();
    expect((await client.getBranch(REPO, repo.default_branch))?.object.sha).toBe(base.object.sha);

    const prUrl = await client.createPullRequest(
      REPO,
      BRANCH,
      repo.default_branch,
      'Configure analysis',
      'Review the workflow',
    );
    expect(prUrl).toBe(`https://github.com/${REPO}/pull/1`);
    expect(await client.listOpenPullRequests(REPO, BRANCH)).toMatchObject([
      { html_url: prUrl, head: { ref: BRANCH }, base: { ref: 'develop' } },
    ]);
    const requests = server.getRecordedRequests();
    expect(requests.every((request) => request.headers.authorization === `Bearer ${TOKEN}`)).toBe(
      true,
    );
    expect(
      requests.every((request) => request.headers['x-github-api-version'] === '2026-03-10'),
    ).toBe(true);
    const commit = requests.find((request) => request.method === 'PUT');
    expect(JSON.parse(commit?.body ?? '{}')).toEqual({
      branch: BRANCH,
      message: 'Add SonarQube analysis',
      content: Buffer.from(workflow).toString('base64'),
    });
  });

  it('follows real pagination headers when listing organization repositories', async () => {
    const server = await newServer()
      .withOrganization(ORGANIZATION, [FIXTURE, { name: 'second' }, { name: 'third' }])
      .withPageSize(1)
      .start();
    const client = new GitHubClient(TOKEN, server.baseUrl());

    expect(
      (await client.listOrganizationRepos(ORGANIZATION)).map((repo) => repo.full_name),
    ).toEqual([REPO, `${ORGANIZATION}/second`, `${ORGANIZATION}/third`]);
    expect(server.getRecordedRequests().map((request) => request.query.page)).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('paginates PRs for the requested source branch', async () => {
    const server = await newServer().withPageSize(1).start();
    const client = new GitHubClient(TOKEN, server.baseUrl());
    const base = await client.getBranch(REPO, 'develop');
    if (!base) throw new Error('Expected a default branch');
    await client.createBranch(REPO, 'release', base.object.sha);
    await client.createBranch(REPO, BRANCH, base.object.sha);
    await client.createFile(REPO, WORKFLOW_PATH, BRANCH, 'name: Analysis', 'Add analysis');
    await client.createPullRequest(REPO, BRANCH, 'develop', 'Analysis for develop', 'Body');
    await client.createPullRequest(REPO, BRANCH, 'release', 'Analysis for release', 'Body');

    expect((await client.listOpenPullRequests(REPO, BRANCH)).map((pr) => pr.number)).toEqual([
      1, 2,
    ]);
    expect(await client.listOpenPullRequests(REPO, 'another-branch')).toEqual([]);
    const pages = server
      .getRecordedRequests()
      .filter(
        (request) => request.method === 'GET' && request.query.head === `${ORGANIZATION}:${BRANCH}`,
      );
    expect(pages.map((request) => request.query.page)).toEqual(['1', '2']);
  });

  it('deletes a branch over HTTP and exposes the resulting missing ref', async () => {
    const server = await newServer().start();
    const client = new GitHubClient(TOKEN, server.baseUrl());
    const base = await client.getBranch(REPO, 'develop');
    if (!base) throw new Error('Expected a default branch');
    await client.createBranch(REPO, BRANCH, base.object.sha);
    await client.deleteBranch(REPO, BRANCH);

    expect(await client.getBranch(REPO, BRANCH)).toBeNull();
    expect(await client.getBranch(REPO, 'develop')).toEqual(base);
    expect(
      server.getRecordedRequests().filter((request) => request.method === 'DELETE'),
    ).toHaveLength(1);
  });

  it('reports an invalid token without retrying', async () => {
    const server = await newServer().start();
    const client = new GitHubClient('invalid-token', server.baseUrl());
    const error = await client.getRepository(REPO).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status: 401, operation: 'getRepository', isRateLimited: false });
    expect(server.getRecordedRequests()).toHaveLength(1);
  });

  it('reports denied writes even when the same token can read', async () => {
    const server = await newServer().withReadOnlyAccess().start();
    const client = new GitHubClient(TOKEN, server.baseUrl());
    const base = await client.getBranch(REPO, 'develop');
    if (!base) throw new Error('Expected a default branch');
    const error = await client
      .createBranch(REPO, BRANCH, base.object.sha)
      .catch((error: unknown) => error);

    expect(error).toMatchObject({
      status: 403,
      operation: 'createBranch',
      isRateLimited: false,
      acceptedPermissions: 'contents=write',
    });
    expect(await client.getBranch(REPO, BRANCH)).toBeNull();
    expect(
      server.getRecordedRequests().filter((request) => request.method === 'POST'),
    ).toHaveLength(1);
  });

  it('preserves existing branches and files and does not duplicate a PR on rejected writes', async () => {
    const server = await newServer().start();
    const client = new GitHubClient(TOKEN, server.baseUrl());
    const base = await client.getBranch(REPO, 'develop');
    if (!base) throw new Error('Expected a default branch');
    await client.createBranch(REPO, BRANCH, base.object.sha);
    expect(
      await client.createBranch(REPO, BRANCH, base.object.sha).catch((error: unknown) => error),
    ).toMatchObject({ status: 422, operation: 'createBranch' });
    await client.createFile(REPO, WORKFLOW_PATH, BRANCH, 'original content', 'Add analysis');
    expect(
      await client
        .createFile(REPO, WORKFLOW_PATH, BRANCH, 'replacement', 'Replace analysis')
        .catch((error: unknown) => error),
    ).toMatchObject({ status: 422, operation: 'createFile' });
    expect(await client.getFileContent(REPO, WORKFLOW_PATH, BRANCH)).toBe('original content');
    const url = await client.createPullRequest(REPO, BRANCH, 'develop', 'Analysis', 'Body');
    expect(
      await client
        .createPullRequest(REPO, BRANCH, 'develop', 'Analysis', 'Body')
        .catch((error: unknown) => error),
    ).toMatchObject({ status: 422, operation: 'createPullRequest' });
    expect((await client.listOpenPullRequests(REPO, BRANCH)).map((pr) => pr.html_url)).toEqual([
      url,
    ]);
  });

  it('distinguishes absent content from an inaccessible repository', async () => {
    const server = await newServer().start();
    const client = new GitHubClient(TOKEN, server.baseUrl());

    expect(await client.getFileContent(REPO, 'missing.yml', 'develop')).toBeNull();
    expect(await client.listRepoTree(REPO, 'missing-directory', 'develop')).toEqual([]);
    expect(
      await client.getRepository(`${ORGANIZATION}/missing`).catch((error: unknown) => error),
    ).toMatchObject({ status: 404, operation: 'getRepository' });
  });
});
