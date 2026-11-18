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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type { ProcessRepoContext } from '@/commands/admin/onboard-ci/github/processor.ts';
import {
  assessRepo,
  CI_BRANCH,
  executeRepo,
} from '@/commands/admin/onboard-ci/github/processor.ts';
import { WORKFLOW_PATH } from '@/commands/admin/onboard-ci/github/templates.ts';
import { ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';
import { GitHubClient } from '@/core/github/client.ts';
import { clearNetworkConfigCache } from '@/core/host/connectivity/network-config.ts';
import { clearSecretCache } from '@/core/host/keychain.ts';
import { ComponentsClient } from '@/core/server/components.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import { restoreEnv } from '../../../_common/isolated-cli-env.ts';
import { isolateNetworkEnv } from '../../../_common/network-env.ts';
import { TestHarness } from '../../harness/index.js';

const REPO = 'test-org/sample';
const PROJECT = 'sample-project';
const BINDINGS = new Map([[REPO, PROJECT]]);
const BUILD_PATH = '.github/workflows/build.yml';
const BUILD =
  'name: Build\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./gradlew build\n';

describe('GitHub onboarding repository lifecycle', () => {
  let harness: TestHarness;
  let restoreEnvironment: () => void;

  beforeEach(async () => {
    harness = await TestHarness.create();
    const restoreNetwork = isolateNetworkEnv();
    const previousHome = process.env[ENV_SONAR_USER_HOME];
    const previousKeychain = process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
    process.env[ENV_SONAR_USER_HOME] = harness.sonarUserHome.path;
    process.env.SONARQUBE_CLI_KEYCHAIN_FILE = harness.keychainJsonFile;
    clearSecretCache();
    clearNetworkConfigCache();
    restoreEnvironment = () => {
      clearSecretCache();
      clearNetworkConfigCache();
      restoreNetwork();
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

  async function setup({
    files = { [BUILD_PATH]: BUILD },
    analyzed = false,
    readOnly = false,
    projectKey = PROJECT,
  }: {
    files?: Record<string, string>;
    analyzed?: boolean;
    readOnly?: boolean;
    projectKey?: string;
  } = {}) {
    const builder = harness
      .newFakeGitHubServer()
      .withOrganization('test-org', [{ name: 'sample', defaultBranch: 'develop', files }]);
    if (readOnly) {
      builder.withReadOnlyAccess();
    }
    const github = await builder.start();
    const server = await harness
      .newFakeServer()
      .withAuthToken('server-token')
      .withProject(projectKey)
      .withAnalyzedProjects(analyzed ? [projectKey] : [])
      .start();
    const ctx: ProcessRepoContext = {
      github: new GitHubClient('github-token', github.baseUrl()),
      components: new ComponentsClient(new SonarHttpClient(server.baseUrl(), 'server-token')),
      serverUrl: server.baseUrl(),
      options: {},
    };
    const repo = await ctx.github.getRepository(REPO);
    return { github, server, ctx, repo };
  }

  it('opens a PR against the current default branch and preserves existing workflows', async () => {
    const { ctx, repo, github } = await setup();
    const assessment = await assessRepo(ctx, repo, BINDINGS);
    expect(assessment).toMatchObject({ outcome: 'proceed', projectKey: PROJECT });
    expect(github.getRecordedRequests().every((request) => request.method === 'GET')).toBe(true);
    const result = await executeRepo(ctx, { ...repo, default_branch: 'stale-branch' }, BINDINGS);
    expect(result).toEqual({
      outcome: 'opened',
      projectKey: PROJECT,
      prUrl: `https://github.com/${REPO}/pull/1`,
    });
    const prs = await ctx.github.listOpenPullRequests(REPO, CI_BRANCH);
    expect(prs[0].base.ref).toBe('develop');
    expect(await ctx.github.getFileContent(REPO, WORKFLOW_PATH, 'develop')).toBeNull();
    expect(await ctx.github.getFileContent(REPO, BUILD_PATH, CI_BRANCH)).toBe(BUILD);
    expect(await ctx.github.getFileContent(REPO, WORKFLOW_PATH, CI_BRANCH)).toContain(
      `sonar.projectKey=${PROJECT}`,
    );
  });

  it('reports unbound, analyzed and unsupported repositories without writes', async () => {
    const { ctx, repo, github } = await setup({ analyzed: true });
    expect(await assessRepo(ctx, repo, new Map())).toEqual({
      outcome: 'skip',
      reason: 'NOT_IN_SONARQUBE',
    });
    expect(await assessRepo(ctx, repo, BINDINGS)).toEqual({
      outcome: 'skip',
      reason: 'ALREADY_ANALYZED',
    });
    expect(await assessRepo(ctx, { ...repo, archived: true }, BINDINGS)).toEqual({
      outcome: 'skip',
      reason: 'UNSUPPORTED_REPOSITORY',
    });
    expect(github.getRecordedRequests().every((request) => request.method === 'GET')).toBe(true);
  });

  it.each<{ name: string; files: Record<string, string>; reason: string }>([
    {
      name: 'target workflow already exists',
      files: { [WORKFLOW_PATH]: 'customer workflow' },
      reason: 'WORKFLOW_COLLISION',
    },
    {
      name: 'Sonar properties already exist',
      files: { 'sonar-project.properties': '' },
      reason: 'ALREADY_CONFIGURED',
    },
    {
      name: 'workflow already runs SonarQube',
      files: { [BUILD_PATH]: 'uses: SonarSource/sonarqube-scan-action@v8' },
      reason: 'ALREADY_CONFIGURED',
    },
    {
      name: 'Gradle workflow runs the Sonar task',
      files: { [BUILD_PATH]: 'run: ./gradlew sonar' },
      reason: 'ALREADY_CONFIGURED',
    },
    {
      name: 'workflow entry is a directory',
      files: { '.github/workflows/external.yml/child': 'unsupported directory' },
      reason: 'UNSUPPORTED_WORKFLOW',
    },
  ])('skips when $name', async ({ files, reason }) => {
    const { ctx, repo } = await setup({ files });
    expect(await assessRepo(ctx, repo, BINDINGS)).toEqual({ outcome: 'skip', reason });
  });

  it('preserves an open onboarding PR and its branch on rerun', async () => {
    const { ctx, repo, github } = await setup();
    await executeRepo(ctx, repo, BINDINGS);
    const before = await ctx.github.getBranch(REPO, CI_BRANCH);
    const count = github.getRecordedRequests().length;
    expect(await executeRepo(ctx, repo, BINDINGS)).toEqual({
      outcome: 'skip',
      reason: 'PR_ALREADY_OPEN',
      prUrl: `https://github.com/${REPO}/pull/1`,
    });
    expect(await ctx.github.getBranch(REPO, CI_BRANCH)).toEqual(before);
    expect(
      github
        .getRecordedRequests()
        .slice(count)
        .every((request) => request.method === 'GET'),
    ).toBe(true);
  });

  it('recreates the onboarding branch after its PR was closed', async () => {
    const { ctx, repo, github } = await setup();
    await executeRepo(ctx, repo, BINDINGS);
    github.closePullRequest(REPO, 1);
    await ctx.github.createFile(REPO, 'leftover.txt', CI_BRANCH, 'edits', 'Old changes');

    expect(await executeRepo(ctx, repo, BINDINGS)).toMatchObject({
      outcome: 'opened',
      prUrl: `https://github.com/${REPO}/pull/2`,
    });
    expect(await ctx.github.getFileContent(REPO, 'leftover.txt', CI_BRANCH)).toBeNull();
    expect(await ctx.github.getFileContent(REPO, BUILD_PATH, CI_BRANCH)).toBe(BUILD);
  });

  it('validates rendered YAML before writes and commits a correctly quoted template', async () => {
    const projectKey = 'sample-project:';
    const bindings = new Map([[REPO, projectKey]]);
    const { ctx, repo, github } = await setup({ projectKey });
    ctx.workflowTemplate =
      'on: push\njobs:\n  scan:\n    runs-on: self-hosted\n    steps:\n      - run: echo {{SONAR_PROJECT_KEY}}\n';
    const expectedFailure = {
      outcome: 'failed' as const,
      error: 'The workflow must contain valid, single-document YAML.',
    };
    expect(await assessRepo(ctx, repo, bindings)).toEqual(expectedFailure);
    expect(await executeRepo(ctx, repo, bindings)).toEqual(expectedFailure);
    expect(github.getRecordedRequests().every((request) => request.method === 'GET')).toBe(true);

    ctx.workflowTemplate = ctx.workflowTemplate.replace(
      'echo {{SONAR_PROJECT_KEY}}',
      "'echo {{SONAR_PROJECT_KEY}}'",
    );
    expect(await executeRepo(ctx, repo, bindings)).toMatchObject({ outcome: 'opened' });
    expect(await ctx.github.getFileContent(REPO, WORKFLOW_PATH, CI_BRANCH)).toBe(
      ctx.workflowTemplate.replace('{{SONAR_PROJECT_KEY}}', projectKey),
    );
  });

  it('propagates Server and GitHub lookup failures as failures without writes', async () => {
    const { ctx, repo, github, server } = await setup();
    expect(await assessRepo(ctx, repo, new Map([[REPO, 'missing-project']]))).toMatchObject({
      outcome: 'failed',
    });
    ctx.components = new ComponentsClient(new SonarHttpClient(server.baseUrl(), 'wrong-token'));
    expect(await assessRepo(ctx, repo, BINDINGS)).toMatchObject({ outcome: 'failed' });
    ctx.github = new GitHubClient('wrong-token', github.baseUrl());
    expect(await executeRepo(ctx, repo, BINDINGS)).toMatchObject({ outcome: 'failed' });
    expect(github.getRecordedRequests().every((request) => request.method === 'GET')).toBe(true);
  });

  it('reports rejected writes and does not claim success', async () => {
    const { ctx, repo } = await setup({ readOnly: true });
    expect(await executeRepo(ctx, repo, BINDINGS)).toMatchObject({
      outcome: 'failed',
      error: expect.stringContaining('403'),
    });
    expect(await ctx.github.getBranch(REPO, CI_BRANCH)).toBeNull();
  });

  it('returns the existing PR when its creation response is lost', async () => {
    const { ctx, repo } = await setup();
    const createPr = ctx.github.createPullRequest.bind(ctx.github);
    spyOn(ctx.github, 'createPullRequest').mockImplementationOnce(async (...args) => {
      await createPr(...args);
      throw new Error('PR response lost');
    });

    expect(await executeRepo(ctx, repo, BINDINGS)).toMatchObject({
      outcome: 'opened',
      prUrl: `https://github.com/${REPO}/pull/1`,
    });
    expect(await ctx.github.listOpenPullRequests(REPO, CI_BRANCH)).toHaveLength(1);
  });

  it('reports a failed workflow write and succeeds on rerun', async () => {
    const { ctx, repo } = await setup();
    spyOn(ctx.github, 'createFile').mockRejectedValueOnce(
      new Error('Connection lost before write'),
    );
    expect(await executeRepo(ctx, repo, BINDINGS)).toEqual({
      outcome: 'failed',
      error: 'Connection lost before write',
    });
    expect(await executeRepo(ctx, repo, BINDINGS)).toMatchObject({ outcome: 'opened' });
  });
});
