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

import { mkdirSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import {
  onboardCiGithub,
  type OnboardCiGithubOptions,
  validateOnboardCiGithubOptions,
} from '@/commands/admin/onboard-ci/github/index.ts';
import { CI_BRANCH } from '@/commands/admin/onboard-ci/github/processor.ts';
import { WORKFLOW_PATH } from '@/commands/admin/onboard-ci/github/templates.ts';
import { OnboardingTelemetry } from '@/commands/admin/onboard-ci/telemetry.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { ALPHA_ENV_VAR } from '@/core/commands/stage.ts';
import { ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';
import { GitHubClient } from '@/core/github/client.ts';
import { clearNetworkConfigCache } from '@/core/host/connectivity/network-config.ts';
import { clearSecretCache } from '@/core/host/keychain.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';
import { restoreEnv } from '../../../_common/isolated-cli-env.ts';
import { isolateNetworkEnv } from '../../../_common/network-env.ts';
import { readTelemetryEvents } from '../../../_common/telemetry-helpers.ts';
import type { FakeGitHubRepository } from '../../harness/fake-github-server.ts';
import { TestHarness } from '../../harness/index.js';

const ORG = 'test-org';
const SETTING = {
  id: 'github-id',
  key: 'my-github',
  type: 'github',
  url: 'https://api.github.com',
};
const OPTIONS: OnboardCiGithubOptions = { org: ORG };
const TEMPLATE =
  'name: Custom\non: push\njobs:\n  scan:\n    runs-on: self-hosted\n    steps:\n      - run: echo {{SONAR_PROJECT_KEY}}\n';

describe('GitHub bulk CI onboarding', () => {
  let harness: TestHarness;
  let console: FakeConsole;
  let restoreEnvironment: () => void;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.withExtraEnv({ [ALPHA_ENV_VAR]: 'true', GITHUB_TOKEN: 'github-token' });
    console = new FakeConsole();
    const previousCwd = process.cwd();
    const previousHome = process.env[ENV_SONAR_USER_HOME];
    const previousKeychain = process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
    const restoreNetwork = isolateNetworkEnv();
    mkdirSync(harness.cwd.path, { recursive: true });
    process.chdir(harness.cwd.path);
    process.env[ENV_SONAR_USER_HOME] = harness.sonarUserHome.path;
    process.env.SONARQUBE_CLI_KEYCHAIN_FILE = harness.keychainJsonFile;
    clearNetworkConfigCache();
    clearSecretCache();
    restoreEnvironment = () => {
      process.chdir(previousCwd);
      clearNetworkConfigCache();
      clearSecretCache();
      restoreNetwork();
      restoreEnv(ENV_SONAR_USER_HOME, previousHome);
      restoreEnv('SONARQUBE_CLI_KEYCHAIN_FILE', previousKeychain);
    };
  });

  afterEach(async () => {
    restoreEnvironment();
    await harness.dispose();
  });

  async function setup(
    repos: FakeGitHubRepository[] = [{ name: 'sample' }],
    readOnlyRepo?: string,
    projectKeys?: string[],
  ) {
    const githubBuilder = harness.newFakeGitHubServer().withOrganization(ORG, repos);
    if (readOnlyRepo) {
      githubBuilder.withReadOnlyAccess(`${ORG}/${readOnlyRepo}`);
    }
    const github = await githubBuilder.start();
    const builder = harness
      .newFakeServer()
      .withAuthToken('server-token')
      .withDopSettings([SETTING])
      .withProvisionProjectsPermission(true)
      .withProjectBindings(
        repos.flatMap(({ name }) =>
          (projectKeys ?? [`${name}-key`]).map((projectKey) => ({
            repository: `${ORG}/${name}`,
            projectKey,
            dopSettingId: SETTING.id,
          })),
        ),
      );
    for (const repo of repos) {
      builder.withProject(`${repo.name}-key`);
    }
    const server = await builder.start();
    harness.withAuth(server.baseUrl(), 'server-token');
    const connection = {
      auth: new ResolvedAuth({
        token: 'server-token',
        serverUrl: server.baseUrl(),
        source: 'state',
        connectionType: 'on-premise',
      }),
      httpClient: new SonarHttpClient(server.baseUrl(), 'server-token'),
    };
    const client = new GitHubClient('github-token', { baseUrl: github.baseUrl() });
    const facts: OnboardingTelemetry[] = [];
    return {
      github,
      server,
      client,
      facts,
      run: (options = OPTIONS, workflowTemplate = validateOnboardCiGithubOptions(options)) => {
        let fact: OnboardingTelemetry | null = null;
        if (!options.dryRun) {
          fact = new OnboardingTelemetry('GitHub');
          facts.push(fact);
        }
        return onboardCiGithub(connection, client, options, console, workflowTemplate, fact);
      },
    };
  }

  it.each([false, true])(
    'skips repositories with multiple project keys (dry run: %s)',
    async (dryRun) => {
      const { run, github, server } = await setup([{ name: 'sample' }], undefined, [
        'first',
        'second',
      ]);
      await run({ ...OPTIONS, dryRun });
      const report = harness.cwd
        .file(dryRun ? 'sonar-onboard-ci-report-dry.json' : 'sonar-onboard-ci-report.json')
        .asJson();
      expect(report[dryRun ? 'wouldSkip' : 'skipped']).toEqual([
        { repo: `${ORG}/sample`, reason: 'MULTIPLE_PROJECT_KEYS' },
      ]);
      expect(report[dryRun ? 'wouldOpenPr' : 'opened']).toEqual([]);
      expect(report.failed).toEqual([]);
      expect(
        [...github.getRecordedRequests(), ...server.getRecordedRequests()].every(
          (request) => request.method === 'GET',
        ),
      ).toBe(true);
    },
  );

  it('opens a PR when repeated bindings contain only one distinct project key', async () => {
    const { run } = await setup([{ name: 'sample' }], undefined, ['sample-key', 'sample-key']);
    await run();
    expect(harness.cwd.file('sonar-onboard-ci-report.json').asJson().opened).toEqual([
      {
        repo: `${ORG}/sample`,
        projectKey: 'sample-key',
        prUrl: `https://github.com/${ORG}/sample/pull/1`,
      },
    ]);
  });

  it('reports opened, skipped and failed repositories, finishing the batch before failing', async () => {
    const { run, server, facts } = await setup(
      [
        { name: 'sample' },
        {
          name: 'configured',
          files: { 'sonar-project.properties': 'sonar.projectKey=configured-key' },
        },
        { name: 'read-only' },
      ],
      'read-only',
    );

    const error = await run().catch((error: unknown) => error);
    expect(error).toMatchObject({ message: '1 repositories failed to process.' });
    expect(facts[0].payload).toEqual({
      platform: 'GitHub',
      created_count: 1,
      existing_count: 0,
      failed_count: 1,
    });

    expect(harness.cwd.file('sonar-onboard-ci-report.json').asJson()).toEqual({
      opened: [
        {
          repo: `${ORG}/sample`,
          projectKey: 'sample-key',
          prUrl: `https://github.com/${ORG}/sample/pull/1`,
        },
      ],
      skipped: [{ repo: `${ORG}/configured`, reason: 'ALREADY_CONFIGURED' }],
      failed: [
        {
          repo: `${ORG}/read-only`,
          error: expect.stringContaining('GitHub API error 403 (createBranch)'),
        },
      ],
    });
    expect(server.getRecordedRequests().every((request) => request.method === 'GET')).toBe(true);
    expect(console.findCall('outro', '1 PRs · 1 skipped · 1 failed')).toBeDefined();
  });

  it('previews rendered workflows without any GitHub or SonarQube writes', async () => {
    const { run, github, server, facts } = await setup([
      { name: 'sample' },
      {
        name: 'configured',
        files: { 'sonar-project.properties': 'sonar.projectKey=configured-key' },
      },
    ]);

    await run({ ...OPTIONS, dryRun: true });
    expect(facts).toHaveLength(0);

    expect(harness.cwd.file('sonar-onboard-ci-report-dry.json').asJson()).toEqual({
      wouldOpenPr: [{ repo: `${ORG}/sample`, projectKey: 'sample-key' }],
      wouldSkip: [{ repo: `${ORG}/configured`, reason: 'ALREADY_CONFIGURED' }],
      failed: [],
    });
    expect(
      [...github.getRecordedRequests(), ...server.getRecordedRequests()].every(
        (request) => request.method === 'GET',
      ),
    ).toBe(true);
    expect(harness.cwd.exists('sonar-onboard-ci-report.json')).toBe(false);
    expect(console.findCall('outro', 'Would open 1 PRs · skip 1 · fail 0')).toBeDefined();
  });

  it('selects repositories by short or full name, ignoring duplicates and comments', async () => {
    const { run, github } = await setup([{ name: 'first' }, { name: 'second' }, { name: 'third' }]);
    harness.cwd.writeFile(
      'repos.txt',
      `# Selected repositories\nfirst\n${ORG}/second\nfirst\nunknown\n`,
    );
    const path = harness.cwd.file('repos.txt').path;

    await run({ ...OPTIONS, reposFile: path });

    expect(
      github
        .getRecordedRequests()
        .filter((request) => request.method === 'POST' && request.path.endsWith('/pulls')),
    ).toHaveLength(2);
    expect(github.getRecordedRequests().some((request) => request.path.includes('/third/'))).toBe(
      false,
    );
    expect(console.findCall('warn', "'unknown' from --repos-file not found")).toBeDefined();
  });

  it('does not open a second PR on a subsequent run', async () => {
    const { run, github, facts } = await setup();

    await run();
    await run();
    expect(facts.map(({ payload }) => payload)).toEqual([
      {
        platform: 'GitHub',
        created_count: 1,
        existing_count: 0,
        failed_count: 0,
      },
      {
        platform: 'GitHub',
        created_count: 0,
        existing_count: 1,
        failed_count: 0,
      },
    ]);

    expect(harness.cwd.file('sonar-onboard-ci-report.json').asJson()).toEqual({
      opened: [],
      failed: [],
      skipped: [
        {
          repo: `${ORG}/sample`,
          reason: 'PR_ALREADY_OPEN',
          prUrl: `https://github.com/${ORG}/sample/pull/1`,
        },
      ],
    });
    expect(
      github
        .getRecordedRequests()
        .filter((request) => request.method === 'POST' && request.path.endsWith('/pulls')),
    ).toHaveLength(1);
    await run({ ...OPTIONS, dryRun: true });
    expect(facts).toHaveLength(2);
  });

  it('does not count a recovered PR as created when the creation response is lost', async () => {
    const { run, client, facts } = await setup();
    const createPr = client.createPullRequest.bind(client);
    const spy = spyOn(GitHubClient.prototype, 'createPullRequest').mockImplementationOnce(
      async (...args) => {
        await createPr(...args);
        throw new Error('Response lost');
      },
    );
    try {
      await run();
      expect(facts[0].payload).toEqual({
        platform: 'GitHub',
        created_count: 0,
        existing_count: 0,
        failed_count: 0,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('uses the validated workflow template even if its file changes', async () => {
    const { run, client, facts } = await setup();
    harness.cwd.writeFile('workflow.yml', TEMPLATE);
    const path = harness.cwd.file('workflow.yml').path;

    const options = { ...OPTIONS, bindingName: SETTING.key, workflowTemplate: path };
    const workflowTemplate = validateOnboardCiGithubOptions(options);
    harness.cwd.writeFile('workflow.yml', 'changed after validation');

    await run(options, workflowTemplate);
    expect(facts[0].payload.created_count).toBe(1);

    expect(await client.getFileContent(`${ORG}/sample`, WORKFLOW_PATH, CI_BRANCH)).toBe(
      TEMPLATE.replaceAll('{{SONAR_PROJECT_KEY}}', 'sample-key'),
    );
  });

  it('writes an empty report when no repositories are selected', async () => {
    const { run, github } = await setup();
    harness.cwd.writeFile('repos.txt', '# Nothing selected\n');

    await run({ ...OPTIONS, reposFile: harness.cwd.file('repos.txt').path });

    expect(harness.cwd.file('sonar-onboard-ci-report.json').asJson()).toEqual({
      opened: [],
      skipped: [],
      failed: [],
    });
    expect(github.getRecordedRequests().every((request) => request.method === 'GET')).toBe(true);
  });

  it('rejects an unreadable repository list without writing to either server', async () => {
    const { run, github, server } = await setup();

    const error = await run({ ...OPTIONS, reposFile: 'missing.txt' }).catch(
      (error: unknown) => error,
    );

    expect(error).toMatchObject({ exitCode: 2, message: expect.stringContaining('--repos-file') });
    expect(
      [...github.getRecordedRequests(), ...server.getRecordedRequests()].every(
        (request) => request.method === 'GET',
      ),
    ).toBe(true);
  });

  it('requires Provision Projects before prompting for a GitHub token', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken('server-token')
      .withProvisionProjectsPermission(false)
      .start();
    harness.withAuth(server.baseUrl(), 'server-token');

    harness.state().withTelemetryEnabled();
    const result = await harness.run(`admin onboard-ci github --org ${ORG}`, {
      extraEnv: { GITHUB_TOKEN: '', SONARQUBE_CLI_MOCK_TTY: '1' },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Provision Projects');
    const events = readTelemetryEvents(harness.sonarUserHome.path, 'Analytics.Cli.CliCiOnboarding');
    expect(events).toHaveLength(1);
    expect(events[0].event_payload).toMatchObject({
      platform: 'GitHub',
      created_count: 0,
      existing_count: 0,
      failed_count: 0,
    });
    await harness.run(`admin onboard-ci github --org ${ORG} --dry-run`);
    expect(
      readTelemetryEvents(harness.sonarUserHome.path, 'Analytics.Cli.CliCiOnboarding'),
    ).toHaveLength(1);
    expect(result.stdout).not.toContain('GitHub personal access token');
    expect(
      server.getRecordedRequests().some((request) => request.path.includes('dop-translation')),
    ).toBe(false);
  });

  it('does not queue onboarding telemetry when telemetry is disabled', async () => {
    const { server } = await setup();
    harness.withAuth(server.baseUrl(), 'server-token');
    const result = await harness.run(`admin onboard-ci github --org ${ORG}`, {
      extraEnv: { GITHUB_TOKEN: '' },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('GitHub token required');
    expect(
      readTelemetryEvents(harness.sonarUserHome.path, 'Analytics.Cli.CliCiOnboarding'),
    ).toEqual([]);
  });

  it('rejects Cloud before prompting for a GitHub token', async () => {
    const server = await harness.newFakeServer().withAuthToken('server-token').start();
    harness.withAuth(server.baseUrl(), 'server-token', 'cloud-org');

    const result = await harness.run(`admin onboard-ci github --org ${ORG}`, {
      extraEnv: { GITHUB_TOKEN: '', SONARQUBE_CLI_MOCK_TTY: '1' },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('requires a SonarQube Server connection');
    expect(result.stdout).not.toContain('GitHub personal access token');
  });

  it('requires a GitHub token in non-interactive mode', async () => {
    await setup();

    const result = await harness.run(`admin onboard-ci github --org ${ORG}`, {
      extraEnv: { GITHUB_TOKEN: '' },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('GitHub token required');
  });

  it.each([
    ['--org invalid/org', 'Invalid --org'],
    [`--org ${ORG} --trigger-on weekly`, 'Trigger mode'],
    [`--org ${ORG} --sonar-token-var-name GITHUB_TOKEN`, 'Invalid analysis-secret name'],
    [`--org ${ORG} --workflow-template missing.yml`, 'file not found or unreadable'],
    [
      `--org ${ORG} --workflow-template workflow.yml --trigger-on both`,
      '--workflow-template cannot be combined with --trigger-on',
    ],
  ])('rejects invalid options: %s', async (flags, message) => {
    const { server, github } = await setup();
    harness.cwd.writeFile('workflow.yml', TEMPLATE);

    const result = await harness.run(`admin onboard-ci github ${flags}`);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(message);
    expect(
      server.getRecordedRequests().some((request) => request.path.includes('dop-translation')),
    ).toBe(false);
    expect(github.getRecordedRequests()).toEqual([]);
  });
});
