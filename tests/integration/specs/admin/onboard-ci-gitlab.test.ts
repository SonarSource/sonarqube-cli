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

import { ALPHA_ENV_VAR } from '@/core/commands/stage.ts';

import type { FakeGitLabProject, FakeGitLabServer } from '../../harness/fake-gitlab-server.js';
import type { FakeSonarQubeServer } from '../../harness/fake-sonarqube-server.js';
import { TestHarness } from '../../harness/index.js';

const GROUP = 'mycompany';
const DOP_SETTING_ID = 'dop-uuid-1';
const DOP_SETTING_KEY = 'my-gitlab';

function dopSettings(gitlabUrl: string) {
  return [{ id: DOP_SETTING_ID, key: DOP_SETTING_KEY, type: 'gitlab', url: gitlabUrl }];
}

async function startServers(
  harness: TestHarness,
  opts: {
    gitlabProjects?: FakeGitLabProject[];
    bindings?: Array<{ projectKey: string; repository: string; dopSettingId: string }>;
    hasProvisionProjects?: boolean;
    analyzedProjectKeys?: string[];
    branchFailureProjectIds?: number[];
  } = {},
): Promise<{ sqsServer: FakeSonarQubeServer; gitlabServer: FakeGitLabServer }> {
  let gitlabBuilder = harness.newFakeGitLabServer().withGroup(GROUP, opts.gitlabProjects ?? []);
  for (const id of opts.branchFailureProjectIds ?? []) {
    gitlabBuilder = gitlabBuilder.withCreateBranchFailure(id);
  }
  const gitlabServer = await gitlabBuilder.start();

  const sqsServer = await harness
    .newFakeServer()
    .withAuthToken('test-token')
    .withDopSettings(dopSettings(gitlabServer.baseUrl()))
    .withProjectBindings(opts.bindings ?? [])
    .withProvisionProjectsPermission(opts.hasProvisionProjects ?? true)
    .withAnalyzedProjects(opts.analyzedProjectKeys ?? [])
    .start();

  harness.withAuth(sqsServer.baseUrl(), 'test-token');
  return { sqsServer, gitlabServer };
}

describe('sonar admin onboard-ci gitlab', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.withExtraEnv({ [ALPHA_ENV_VAR]: 'true', GITLAB_TOKEN: 'gl-token' });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  describe('validation', () => {
    it('exits 1 when no GitLab token is provided', async () => {
      const { sqsServer } = await startServers(harness);
      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`, {
        extraEnv: { GITLAB_TOKEN: '' },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('GitLab token required');
      expect(sqsServer.getRecordedRequests().some((r) => r.path.includes('dop-translation'))).toBe(
        false,
      );
    });

    it('exits 2 for invalid --trigger-on value', async () => {
      await startServers(harness);
      const result = await harness.run(
        `admin onboard-ci gitlab --group ${GROUP} --trigger-on weekly`,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Invalid --trigger-on value 'weekly'");
    });

    it('exits 1 when connected to SonarQube Cloud', async () => {
      const sqsServer = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(sqsServer.baseUrl(), 'test-token', 'my-org');

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('SonarQube Server');
    });

    it('exits 2 for invalid --sonar-token-var-name', async () => {
      await startServers(harness);
      const result = await harness.run(
        `admin onboard-ci gitlab --group ${GROUP} --sonar-token-var-name 1INVALID`,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Invalid --sonar-token-var-name');
    });

    it('exits 2 for --repos-file pointing to non-existent file', async () => {
      await startServers(harness);
      const result = await harness.run(
        `admin onboard-ci gitlab --group ${GROUP} --repos-file /no/such/file.txt`,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('file not found or unreadable');
    });

    it('exits 2 for invalid --stage value', async () => {
      await startServers(harness);
      const result = await harness.run(
        `admin onboard-ci gitlab --group ${GROUP} --stage 'foo: bar'`,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Invalid --stage value 'foo: bar'");
    });

    it('exits 2 for invalid --scanner-property (missing =)', async () => {
      await startServers(harness);
      const result = await harness.run(
        `admin onboard-ci gitlab --group ${GROUP} --scanner-property sonar.scanner.engineJarPath`,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Invalid --scanner-property 'sonar.scanner.engineJarPath'");
    });

    it('exits 2 for invalid --scanner-property (missing key)', async () => {
      await startServers(harness);
      const result = await harness.run(
        `admin onboard-ci gitlab --group ${GROUP} --scanner-property '=value'`,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Invalid --scanner-property '=value'");
    });

    it('exits 2 for invalid --scanner-property (key starts with -D)', async () => {
      await startServers(harness);
      const result = await harness.run(
        `admin onboard-ci gitlab --group ${GROUP} --scanner-property '-Dsonar.foo=bar'`,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Invalid --scanner-property key '-Dsonar.foo'");
    });

    it('exits 2 for invalid --scanner-property (value contains ": ")', async () => {
      await startServers(harness);
      const result = await harness.run(
        `admin onboard-ci gitlab --group ${GROUP} --scanner-property 'sonar.projectName=My App: v2'`,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Invalid --scanner-property value for 'sonar.projectName'");
    });

    it('exits 2 for invalid --scanner-property (value contains " #")', async () => {
      await startServers(harness);
      const result = await harness.run(
        `admin onboard-ci gitlab --group ${GROUP} --scanner-property 'sonar.foo=bar #x'`,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Invalid --scanner-property value for 'sonar.foo'");
    });
  });

  describe('preflight checks', () => {
    it('exits 1 when user lacks PROVISION_PROJECTS permission', async () => {
      await startServers(harness, { hasProvisionProjects: false });
      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Provision Projects');
    });

    it('exits 1 when no GitLab DOP settings are configured in SonarQube', async () => {
      const sqsServer = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withDopSettings([])
        .withProvisionProjectsPermission(true)
        .start();
      harness.withAuth(sqsServer.baseUrl(), 'test-token');

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No GitLab configuration found');
    });

    it('exits 2 when --binding-name does not match any configured setting', async () => {
      await startServers(harness);
      const result = await harness.run(
        `admin onboard-ci gitlab --group ${GROUP} --binding-name unknown-key`,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("GitLab configuration 'unknown-key' not found");
      expect(result.stderr).toContain(DOP_SETTING_KEY);
    });

    it('exits 2 when multiple DOP settings exist and --binding-name is not given', async () => {
      const gitlabServer = await harness.newFakeGitLabServer().withGroup(GROUP, []).start();
      const sqsServer = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withDopSettings([
          { id: 'id-1', key: 'gitlab-one', type: 'gitlab', url: gitlabServer.baseUrl() },
          { id: 'id-2', key: 'gitlab-two', type: 'gitlab', url: gitlabServer.baseUrl() },
        ])
        .withProvisionProjectsPermission(true)
        .start();
      harness.withAuth(sqsServer.baseUrl(), 'test-token');

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Multiple GitLab configurations found');
      expect(result.stderr).toContain('gitlab-one');
      expect(result.stderr).toContain('gitlab-two');
    });
  });

  describe('skip conditions', () => {
    it('skips repo when Jenkinsfile is present (OTHER_CI_DETECTED)', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 1,
            name: 'jenkins-repo',
            path_with_namespace: `${GROUP}/jenkins-repo`,
            default_branch: 'main',
            rootFiles: [{ name: 'Jenkinsfile' }],
          },
        ],
        bindings: [
          { projectKey: 'jenkins-repo-key', repository: '1', dopSettingId: DOP_SETTING_ID },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('other CI detected');
      expect(gitlabServer.createdMrs).toHaveLength(0);
    });

    it('skips repo when .gitlab-ci.yml already references SONAR_HOST_URL (ALREADY_CONFIGURED)', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 2,
            name: 'configured-repo',
            path_with_namespace: `${GROUP}/configured-repo`,
            default_branch: 'main',
            rootFiles: [
              {
                name: '.gitlab-ci.yml',
                content:
                  'include:\n  - local: other.yml\nvariables:\n  SONAR_HOST_URL: https://sonar.example.com\n',
              },
            ],
          },
        ],
        bindings: [
          { projectKey: 'configured-repo-key', repository: '2', dopSettingId: DOP_SETTING_ID },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('already configured');
      expect(gitlabServer.createdMrs).toHaveLength(0);
    });

    it('skips repo when sonar-project.properties is present (ALREADY_CONFIGURED)', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 3,
            name: 'sonar-props-repo',
            path_with_namespace: `${GROUP}/sonar-props-repo`,
            default_branch: 'main',
            rootFiles: [{ name: 'sonar-project.properties' }],
          },
        ],
        bindings: [
          { projectKey: 'sonar-props-repo-key', repository: '3', dopSettingId: DOP_SETTING_ID },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('already configured');
      expect(gitlabServer.createdMrs).toHaveLength(0);
    });

    it('skips repos not bound in SonarQube (NOT_IN_SONARQUBE)', async () => {
      const { gitlabServer, sqsServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 4,
            name: 'new-repo',
            path_with_namespace: `${GROUP}/new-repo`,
            default_branch: 'main',
            rootFiles: [],
          },
        ],
        bindings: [],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('not bound in SonarQube');
      expect(gitlabServer.createdMrs).toHaveLength(0);
      const boundProjectReq = sqsServer
        .getRecordedRequests()
        .find((r) => r.path === '/api/v2/dop-translation/bound-projects' && r.method === 'POST');
      expect(boundProjectReq).toBeUndefined();
    });

    it('skips repo when sonar/add-sonar-analysis-job MR is already open (MR_ALREADY_OPEN)', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 5,
            name: 'open-mr-repo',
            path_with_namespace: `${GROUP}/open-mr-repo`,
            default_branch: 'main',
            rootFiles: [],
            hasOpenSonarMr: true,
          },
        ],
        bindings: [
          { projectKey: 'mycompany_open-mr-repo', repository: '5', dopSettingId: DOP_SETTING_ID },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('MR already open');
      expect(gitlabServer.createdMrs).toHaveLength(0);
    });

    it('skips repo whose SonarQube project already has analyses (ALREADY_CONFIGURED)', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 6,
            name: 'analyzed-repo',
            path_with_namespace: `${GROUP}/analyzed-repo`,
            default_branch: 'main',
            rootFiles: [],
          },
        ],
        bindings: [
          { projectKey: 'mycompany_analyzed-repo', repository: '6', dopSettingId: DOP_SETTING_ID },
        ],
        analyzedProjectKeys: ['mycompany_analyzed-repo'],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('already configured');
      expect(gitlabServer.createdMrs).toHaveLength(0);
    });

    it('prints a neutral message when all repos are skipped and no failures occurred', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 7,
            name: 'jenkins-only',
            path_with_namespace: `${GROUP}/jenkins-only`,
            default_branch: 'main',
            rootFiles: [{ name: 'Jenkinsfile' }],
          },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Opened 0 MRs');
      expect(result.stdout).not.toContain('❌');
      expect(gitlabServer.createdMrs).toHaveLength(0);
    });
  });

  describe('--stage flag', () => {
    it('skips repo when --stage is not defined in existing stages list (STAGE_NOT_IN_CI)', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 10,
            name: 'staged-repo',
            path_with_namespace: `${GROUP}/staged-repo`,
            default_branch: 'main',
            rootFiles: [{ name: '.gitlab-ci.yml', content: 'stages:\n  - build\n  - test\n' }],
          },
        ],
        bindings: [
          { projectKey: 'staged-repo-key', repository: '10', dopSettingId: DOP_SETTING_ID },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP} --stage sonar`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('not defined in');
      expect(gitlabServer.createdMrs).toHaveLength(0);
    });

    it('skips when --stage is omitted and the implicit test stage is absent from a custom stages list', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 11,
            name: 'no-test-stage-repo',
            path_with_namespace: `${GROUP}/no-test-stage-repo`,
            default_branch: 'main',
            rootFiles: [{ name: '.gitlab-ci.yml', content: 'stages:\n  - compile\n  - release\n' }],
          },
        ],
        bindings: [
          {
            projectKey: 'mycompany_no-test-stage-repo',
            repository: '11',
            dopSettingId: DOP_SETTING_ID,
          },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("stage 'test' not defined in");
      expect(gitlabServer.createdMrs).toHaveLength(0);
    });

    it('does not skip when --stage is .post or .pre (GitLab implicit stages)', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 12,
            name: 'implicit-stage-repo',
            path_with_namespace: `${GROUP}/implicit-stage-repo`,
            default_branch: 'main',
            rootFiles: [{ name: '.gitlab-ci.yml', content: 'stages:\n  - build\n  - deploy\n' }],
          },
        ],
        bindings: [
          {
            projectKey: 'mycompany_implicit-stage-repo',
            repository: '12',
            dopSettingId: DOP_SETTING_ID,
          },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP} --stage .post`);

      expect(result.exitCode).toBe(0);
      expect(gitlabServer.createdMrs).toHaveLength(1);
    });

    it('does not skip when --stage is already in the existing stages list', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 13,
            name: 'staged-ok-repo',
            path_with_namespace: `${GROUP}/staged-ok-repo`,
            default_branch: 'main',
            rootFiles: [{ name: '.gitlab-ci.yml', content: 'stages:\n  - build\n  - sonar\n' }],
          },
        ],
        bindings: [
          {
            projectKey: 'mycompany_staged-ok-repo',
            repository: '13',
            dopSettingId: DOP_SETTING_ID,
          },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP} --stage sonar`);

      expect(result.exitCode).toBe(0);
      expect(gitlabServer.createdMrs).toHaveLength(1);
    });
  });

  describe('--trigger-on flag', () => {
    it('commits only the MR pipeline rule when --trigger-on mr', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 20,
            name: 'trigger-mr-repo',
            path_with_namespace: `${GROUP}/trigger-mr-repo`,
            default_branch: 'main',
            rootFiles: [],
          },
        ],
        bindings: [
          {
            projectKey: 'mycompany_trigger-mr-repo',
            repository: '20',
            dopSettingId: DOP_SETTING_ID,
          },
        ],
      });

      await harness.run(`admin onboard-ci gitlab --group ${GROUP} --trigger-on mr`);

      const ciYml = gitlabServer.committedFiles.find((f) => f.path === '.gitlab-ci.yml');
      expect(ciYml).toBeDefined();
      expect(ciYml!.content).toContain("$CI_PIPELINE_SOURCE == 'merge_request_event'");
      expect(ciYml!.content).not.toContain('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
    });

    it('commits only the default branch rule when --trigger-on main', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 21,
            name: 'trigger-main-repo',
            path_with_namespace: `${GROUP}/trigger-main-repo`,
            default_branch: 'main',
            rootFiles: [],
          },
        ],
        bindings: [
          {
            projectKey: 'mycompany_trigger-main-repo',
            repository: '21',
            dopSettingId: DOP_SETTING_ID,
          },
        ],
      });

      await harness.run(`admin onboard-ci gitlab --group ${GROUP} --trigger-on main`);

      const ciYml = gitlabServer.committedFiles.find((f) => f.path === '.gitlab-ci.yml');
      expect(ciYml).toBeDefined();
      expect(ciYml!.content).toContain('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
      expect(ciYml!.content).not.toContain("$CI_PIPELINE_SOURCE == 'merge_request_event'");
    });

    it('commits both rules when --trigger-on both (default)', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 22,
            name: 'trigger-both-repo',
            path_with_namespace: `${GROUP}/trigger-both-repo`,
            default_branch: 'main',
            rootFiles: [],
          },
        ],
        bindings: [
          {
            projectKey: 'mycompany_trigger-both-repo',
            repository: '22',
            dopSettingId: DOP_SETTING_ID,
          },
        ],
      });

      await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      const ciYml = gitlabServer.committedFiles.find((f) => f.path === '.gitlab-ci.yml');
      expect(ciYml).toBeDefined();
      expect(ciYml!.content).toContain("$CI_PIPELINE_SOURCE == 'merge_request_event'");
      expect(ciYml!.content).toContain('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
    });
  });

  describe('--dry-run', () => {
    it('prints repo counts without writing to GitLab', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 30,
            name: 'repo-a',
            path_with_namespace: `${GROUP}/repo-a`,
            default_branch: 'main',
            rootFiles: [],
          },
          {
            id: 31,
            name: 'repo-b',
            path_with_namespace: `${GROUP}/repo-b`,
            default_branch: 'main',
            rootFiles: [],
          },
        ],
        bindings: [
          { projectKey: 'mycompany_repo-a', repository: '30', dopSettingId: DOP_SETTING_ID },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP} --dry-run`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('DRY RUN');
      expect(result.stdout).toContain('would open MR');
      expect(result.stdout).toContain('No changes were made');
      expect(gitlabServer.createdMrs).toHaveLength(0);
      expect(gitlabServer.committedFiles).toHaveLength(0);
      expect(gitlabServer.createdBranches).toHaveLength(0);
    });

    it('writes a report file', async () => {
      await startServers(harness, {
        gitlabProjects: [
          {
            id: 32,
            name: 'some-repo',
            path_with_namespace: `${GROUP}/some-repo`,
            default_branch: 'main',
            rootFiles: [],
          },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP} --dry-run`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('sonar-onboard-ci-report-dry.json');
      expect(harness.cwd.exists('sonar-onboard-ci-report-dry.json')).toBe(true);
    });
  });

  describe('--repos-file', () => {
    it('limits which repos are processed', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 40,
            name: 'repo-one',
            path_with_namespace: `${GROUP}/repo-one`,
            default_branch: 'main',
            rootFiles: [],
          },
          {
            id: 41,
            name: 'repo-two',
            path_with_namespace: `${GROUP}/repo-two`,
            default_branch: 'main',
            rootFiles: [],
          },
          {
            id: 42,
            name: 'repo-three',
            path_with_namespace: `${GROUP}/repo-three`,
            default_branch: 'main',
            rootFiles: [],
          },
        ],
        bindings: [
          { projectKey: 'mycompany_repo-one', repository: '40', dopSettingId: DOP_SETTING_ID },
          { projectKey: 'mycompany_repo-three', repository: '42', dopSettingId: DOP_SETTING_ID },
        ],
      });

      harness.cwd.writeFile('repos.txt', `repo-one\nrepo-three\n`);

      const result = await harness.run(
        `admin onboard-ci gitlab --group ${GROUP} --repos-file repos.txt`,
      );

      expect(result.exitCode).toBe(0);
      expect(gitlabServer.createdMrs).toHaveLength(2);
      const openedRepos = gitlabServer.createdMrs.map((mr) => mr.projectId);
      expect(openedRepos).toContain(40);
      expect(openedRepos).toContain(42);
      expect(openedRepos).not.toContain(41);
    });

    it('warns for paths not found in group', async () => {
      await startServers(harness, {
        gitlabProjects: [
          {
            id: 43,
            name: 'repo-one',
            path_with_namespace: `${GROUP}/repo-one`,
            default_branch: 'main',
            rootFiles: [],
          },
        ],
      });

      harness.cwd.writeFile('repos.txt', `repo-one\nnonexistent\n`);

      const result = await harness.run(
        `admin onboard-ci gitlab --group ${GROUP} --repos-file repos.txt`,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('nonexistent');
      expect(result.stderr).toContain('not found in group');
    });

    it('warns "not eligible" (not "not found") for repos in group with no default branch', async () => {
      await startServers(harness, {
        gitlabProjects: [
          {
            id: 44,
            name: 'empty-repo',
            path_with_namespace: `${GROUP}/empty-repo`,
            default_branch: null,
            rootFiles: [],
          },
        ],
      });

      harness.cwd.writeFile('repos.txt', `empty-repo\n`);

      const result = await harness.run(
        `admin onboard-ci gitlab --group ${GROUP} --repos-file repos.txt`,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('empty-repo');
      expect(result.stderr).toContain('not eligible');
      expect(result.stderr).not.toContain('not found in group');
    });
  });

  describe('MR content', () => {
    it('appends the sonarqube-analysis job directly into .gitlab-ci.yml', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 50,
            name: 'ci-repo',
            path_with_namespace: `${GROUP}/ci-repo`,
            default_branch: 'main',
            rootFiles: [{ name: '.gitlab-ci.yml', content: 'stages:\n  - test\n' }],
          },
        ],
        bindings: [
          { projectKey: 'mycompany_ci-repo', repository: '50', dopSettingId: DOP_SETTING_ID },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(0);
      expect(
        gitlabServer.committedFiles.find((f) => f.path === '.gitlab/sonar.yml'),
      ).toBeUndefined();
      const ciYml = gitlabServer.committedFiles.find((f) => f.path === '.gitlab-ci.yml');
      expect(ciYml).toBeDefined();
      expect(ciYml!.content).toContain('sonarqube-analysis:');
      expect(ciYml!.content).toContain('-Dsonar.projectKey=');
      expect(ciYml!.content).toContain('stages:\n  - test');
    });

    it('uses custom local CI config path when set', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 51,
            name: 'custom-path-repo',
            path_with_namespace: `${GROUP}/custom-path-repo`,
            default_branch: 'main',
            rootFiles: [{ name: '.gitlab/ci.yml', content: 'stages:\n  - test\n' }],
            ciConfigPath: '.gitlab/ci.yml',
          },
        ],
        bindings: [
          {
            projectKey: 'mycompany_custom-path-repo',
            repository: '51',
            dopSettingId: DOP_SETTING_ID,
          },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(0);
      expect(gitlabServer.createdMrs).toHaveLength(1);
      const committed = gitlabServer.committedFiles.find((f) => f.path === '.gitlab/ci.yml');
      expect(committed).toBeDefined();
      expect(committed!.content).toContain('sonarqube-analysis:');
    });

    it('MR description references custom --sonar-token-var-name, not the default SONAR_TOKEN', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 52,
            name: 'custom-token-repo',
            path_with_namespace: `${GROUP}/custom-token-repo`,
            default_branch: 'main',
            rootFiles: [],
          },
        ],
        bindings: [
          {
            projectKey: 'mycompany_custom-token-repo',
            repository: '52',
            dopSettingId: DOP_SETTING_ID,
          },
        ],
      });

      await harness.run(
        `admin onboard-ci gitlab --group ${GROUP} --sonar-token-var-name MY_SONAR_TOKEN`,
      );

      expect(gitlabServer.createdMrs).toHaveLength(1);
      expect(gitlabServer.createdMrs[0].description).toContain('`MY_SONAR_TOKEN`');
      expect(gitlabServer.createdMrs[0].description).not.toContain('`SONAR_TOKEN`');
    });

    it('skips repo with external CI config path (CUSTOM_CI_CONFIG_PATH)', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 53,
            name: 'external-ci-repo',
            path_with_namespace: `${GROUP}/external-ci-repo`,
            default_branch: 'main',
            rootFiles: [],
            ciConfigPath: 'ci/config.yml@infra/ci-templates',
          },
        ],
        bindings: [
          { projectKey: 'external-ci-repo-key', repository: '53', dopSettingId: DOP_SETTING_ID },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('external CI config');
      expect(gitlabServer.createdMrs).toHaveLength(0);
    });
  });

  describe('happy path', () => {
    it('opens an MR for a repo bound in SonarQube', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 60,
            name: 'my-repo',
            path_with_namespace: `${GROUP}/my-repo`,
            default_branch: 'main',
            rootFiles: [],
          },
        ],
        bindings: [
          { projectKey: 'mycompany_my-repo', repository: '60', dopSettingId: DOP_SETTING_ID },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Opened 1 MRs');
      expect(gitlabServer.createdMrs).toHaveLength(1);
      expect(gitlabServer.createdMrs[0].projectId).toBe(60);
      expect(gitlabServer.createdMrs[0].sourceBranch).toBe('sonar/add-sonar-analysis-job');
      const sqsRequests = gitlabServer.getRecordedRequests();
      expect(sqsRequests.some((r) => r.path.includes('bound-projects'))).toBe(false);
    });

    it('recovers from an orphaned CI branch by deleting and recreating it', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 70,
            name: 'orphan-branch-repo',
            path_with_namespace: `${GROUP}/orphan-branch-repo`,
            default_branch: 'main',
            rootFiles: [],
            existingBranches: ['sonar/add-sonar-analysis-job'],
          },
        ],
        bindings: [
          {
            projectKey: 'mycompany_orphan-branch-repo',
            repository: '70',
            dopSettingId: DOP_SETTING_ID,
          },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Opened 1 MRs');
      expect(gitlabServer.deletedBranches).toHaveLength(1);
      expect(gitlabServer.deletedBranches[0]).toEqual({
        projectId: 70,
        branch: 'sonar/add-sonar-analysis-job',
      });
      expect(gitlabServer.createdMrs).toHaveLength(1);
    });

    it('handles a mix of repos: opens MRs, skips others, and prints summary', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 61,
            name: 'clean-repo',
            path_with_namespace: `${GROUP}/clean-repo`,
            default_branch: 'main',
            rootFiles: [],
          },
          {
            id: 62,
            name: 'jenkins-repo',
            path_with_namespace: `${GROUP}/jenkins-repo`,
            default_branch: 'main',
            rootFiles: [{ name: 'Jenkinsfile' }],
          },
          {
            id: 63,
            name: 'sonar-repo',
            path_with_namespace: `${GROUP}/sonar-repo`,
            default_branch: 'main',
            rootFiles: [{ name: '.gitlab-ci.yml', content: 'variables:\n  SONAR_HOST_URL: x\n' }],
          },
        ],
        bindings: [
          { projectKey: 'mycompany_clean-repo', repository: '61', dopSettingId: DOP_SETTING_ID },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(0);
      expect(gitlabServer.createdMrs).toHaveLength(1);
      expect(result.stdout).toContain('Opened 1 MRs');
      expect(result.stdout).toContain('skipped');
      expect(result.stdout).toContain('failed');
    });

    it('writes a report file', async () => {
      await startServers(harness, {
        gitlabProjects: [
          {
            id: 64,
            name: 'my-repo',
            path_with_namespace: `${GROUP}/my-repo`,
            default_branch: 'main',
            rootFiles: [],
          },
        ],
        bindings: [
          { projectKey: 'mycompany_my-repo', repository: '64', dopSettingId: DOP_SETTING_ID },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('sonar-onboard-ci-report.json');
      expect(harness.cwd.exists('sonar-onboard-ci-report.json')).toBe(true);
      const report = harness.cwd.file('sonar-onboard-ci-report.json').asJson() as {
        opened: Array<{ repo: string; projectKey: string; mrUrl: string }>;
      };
      expect(report.opened).toHaveLength(1);
      expect(report.opened[0].repo).toBe(`${GROUP}/my-repo`);
    });

    it('injects --scanner-property values into the generated CI script', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 66,
            name: 'scanner-prop-repo',
            path_with_namespace: `${GROUP}/scanner-prop-repo`,
            default_branch: 'main',
            rootFiles: [],
          },
        ],
        bindings: [
          {
            projectKey: 'mycompany_scanner-prop-repo',
            repository: '66',
            dopSettingId: DOP_SETTING_ID,
          },
        ],
      });

      await harness.run(
        `admin onboard-ci gitlab --group ${GROUP}` +
          ` --scanner-property sonar.scanner.engineJarPath=/path/to/engine.jar` +
          ` --scanner-property sonar.buildsystem.autoconfig.disabled=false`,
      );

      const ciYml = gitlabServer.committedFiles.find((f) => f.path === '.gitlab-ci.yml');
      expect(ciYml).toBeDefined();
      expect(ciYml!.content).toContain(
        `-Dsonar.projectKey="mycompany_scanner-prop-repo" -Dsonar.scanner.engineJarPath='/path/to/engine.jar' -Dsonar.buildsystem.autoconfig.disabled='false'`,
      );
    });

    it('accepts token from GITLAB_TOKEN env var', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 65,
            name: 'env-repo',
            path_with_namespace: `${GROUP}/env-repo`,
            default_branch: 'main',
            rootFiles: [],
          },
        ],
        bindings: [
          { projectKey: 'mycompany_env-repo', repository: '65', dopSettingId: DOP_SETTING_ID },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`, {
        extraEnv: { GITLAB_TOKEN: 'env-gl-token' },
      });

      expect(result.exitCode).toBe(0);
      expect(gitlabServer.createdMrs).toHaveLength(1);
    });
  });

  describe('error handling', () => {
    it('exits 1 when at least one repo fails to process', async () => {
      await startServers(harness, {
        gitlabProjects: [
          {
            id: 90,
            name: 'ok-repo',
            path_with_namespace: `${GROUP}/ok-repo`,
            default_branch: 'main',
            rootFiles: [],
          },
          {
            id: 91,
            name: 'broken-repo',
            path_with_namespace: `${GROUP}/broken-repo`,
            default_branch: 'main',
            rootFiles: [],
          },
        ],
        bindings: [
          { projectKey: 'mycompany_ok-repo', repository: '90', dopSettingId: DOP_SETTING_ID },
          { projectKey: 'mycompany_broken-repo', repository: '91', dopSettingId: DOP_SETTING_ID },
        ],
        branchFailureProjectIds: [91],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('1 repositories failed to process');
    });

    it('exits 1 even when some repos succeed alongside failures', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 92,
            name: 'good-repo',
            path_with_namespace: `${GROUP}/good-repo`,
            default_branch: 'main',
            rootFiles: [],
          },
          {
            id: 93,
            name: 'bad-repo',
            path_with_namespace: `${GROUP}/bad-repo`,
            default_branch: 'main',
            rootFiles: [],
          },
        ],
        bindings: [
          { projectKey: 'mycompany_good-repo', repository: '92', dopSettingId: DOP_SETTING_ID },
          { projectKey: 'mycompany_bad-repo', repository: '93', dopSettingId: DOP_SETTING_ID },
        ],
        branchFailureProjectIds: [93],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Opened 1 MRs');
      expect(result.stderr).toContain('1 repositories failed to process');
      expect(gitlabServer.createdMrs).toHaveLength(1);
    });
  });

  describe('empty CI file', () => {
    it('uses updateFile (not createFile) when existing .gitlab-ci.yml is empty', async () => {
      const { gitlabServer } = await startServers(harness, {
        gitlabProjects: [
          {
            id: 82,
            name: 'empty-ci-repo',
            path_with_namespace: `${GROUP}/empty-ci-repo`,
            default_branch: 'main',
            rootFiles: [{ name: '.gitlab-ci.yml', content: '' }],
          },
        ],
        bindings: [
          {
            projectKey: 'mycompany_empty-ci-repo',
            repository: '82',
            dopSettingId: DOP_SETTING_ID,
          },
        ],
      });

      const result = await harness.run(`admin onboard-ci gitlab --group ${GROUP}`);

      expect(result.exitCode).toBe(0);
      expect(gitlabServer.createdMrs).toHaveLength(1);
      const committed = gitlabServer.committedFiles.find((f) => f.path === '.gitlab-ci.yml');
      expect(committed).toBeDefined();
      expect(committed?.content).toContain('sonarqube-analysis:');
    });
  });
});
