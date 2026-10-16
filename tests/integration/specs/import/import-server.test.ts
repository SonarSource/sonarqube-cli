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

// Integration tests for `sonar import` against SonarQube Server: setting selection and the
// personal access token (PAT) gate. No platform can be listed yet, so a run that gets past the
// gate ends on "not supported yet".

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { type FakeSonarQubeServer, TestHarness } from '../../harness';

const GITLAB = { id: 'gl-id', key: 'my-gitlab', type: 'gitlab', url: 'https://gitlab.example.com' };
const GITHUB = { id: 'gh-id', key: 'my-github', type: 'github', url: 'https://api.github.com' };
const AZURE = { id: 'az-id', key: 'my-azure', type: 'azure', url: 'https://dev.azure.com/org' };

describe('sonar import on SonarQube Server', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function startServer(
    configure: (server: ReturnType<TestHarness['newFakeServer']>) => void = () => undefined,
  ): Promise<FakeSonarQubeServer> {
    const builder = harness.newFakeServer().withAuthToken('test-token');
    configure(builder);
    const server = await builder.start();
    harness.withAuth(server.baseUrl(), 'test-token');
    return server;
  }

  describe('DevOps platform setting selection', () => {
    it('fails when no DevOps platform is configured', async () => {
      await startServer();

      const result = await harness.run('import --all');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        'No DevOps platform integration is configured on this SonarQube Server.',
      );
    });

    it('uses the only configured setting without asking', async () => {
      await startServer((s) => s.withDopSettings([GITLAB]));

      const result = await harness.run('import --non-interactive --all');

      expect(result.stdout).toContain('DevOps platform: my-gitlab (GitLab)');
    });

    it('exits 2 with the available keys when several are configured and --dop-setting is missing', async () => {
      await startServer((s) => s.withDopSettings([GITLAB, GITHUB]));

      const result = await harness.run('import --non-interactive --all');

      expect(result.exitCode).toBe(2);
      const output = result.stdout + result.stderr;
      expect(output).toContain('pass --dop-setting <key>');
      expect(output).toContain('my-gitlab, my-github');
    });

    it('exits 2 when several are configured and CI=true, even without --non-interactive', async () => {
      await startServer((s) => s.withDopSettings([GITLAB, GITHUB]));

      const result = await harness.run('import --all', { extraEnv: { CI: 'true' } });

      expect(result.exitCode).toBe(2);
    });

    it('picks the setting named by --dop-setting', async () => {
      await startServer((s) => s.withDopSettings([GITLAB, GITHUB]));

      const result = await harness.run('import --non-interactive --all --dop-setting my-github');

      expect(result.stdout).toContain('DevOps platform: my-github (GitHub)');
    });

    it('exits 2 for a --dop-setting key that does not exist', async () => {
      await startServer((s) => s.withDopSettings([GITLAB]));

      const result = await harness.run('import --non-interactive --all --dop-setting nope');

      expect(result.exitCode).toBe(2);
      const output = result.stdout + result.stderr;
      expect(output).toContain("No DevOps platform setting has the key 'nope'.");
      expect(output).toContain('Available keys: my-gitlab.');
    });

    it(
      'asks which setting to use when several are configured and a terminal is available',
      async () => {
        await startServer((s) => s.withDopSettings([GITLAB, AZURE]));

        const session = harness.runInteractive('import --all', {
          extraEnv: { CI: 'false', SONARQUBE_CLI_MOCK_TTY: '1' },
        });
        await session.waitText('Which DevOps platform do you want to import from?');
        session.keyDown();
        session.keyEnter();
        const result = await session.waitFinish();

        expect(result.stdout).toContain('my-gitlab (GitLab)');
        expect(result.stdout).toContain('my-azure (Azure DevOps)');
        expect(result.stdout).toContain('DevOps platform: my-azure (Azure DevOps)');
      },
      { timeout: 15000 },
    );
  });

  describe('personal access token gate', () => {
    it('prints the connect URL and exits 1 when no token is connected', async () => {
      const server = await startServer((s) =>
        s.withDopSettings([GITLAB]).withPatResponse('my-gitlab', {
          status: 400,
          message: "personal access token for 'my-gitlab' is missing",
        }),
      );

      const result = await harness.run('import --non-interactive --all');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain(
        "No personal access token is connected for GitLab setting 'my-gitlab'.",
      );
      expect(output).toContain(`${server.baseUrl()}/projects/create?mode=gitlab,`);
      expect(output).not.toContain('resetPat');
    });

    it('recognises the GitLab capitalisation of "is missing"', async () => {
      await startServer((s) =>
        s.withDopSettings([GITLAB]).withPatResponse('my-gitlab', {
          status: 400,
          message: "Personal Access Token for 'my-gitlab' Is Missing",
        }),
      );

      const result = await harness.run('import --non-interactive --all');

      expect(result.stdout + result.stderr).toContain('No personal access token is connected');
    });

    it('asks the user to reconnect when the platform rejects the token', async () => {
      const server = await startServer((s) =>
        s.withDopSettings([GITLAB]).withPatResponse('my-gitlab', {
          status: 400,
          message: 'Invalid personal access token',
        }),
      );

      const result = await harness.run('import --non-interactive --all');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('was rejected by GitLab');
      expect(output).toContain(`${server.baseUrl()}/projects/create?mode=gitlab&resetPat=1,`);
    });

    it('prints the exact URL under CI=true and never calls the web UI', async () => {
      const server = await startServer((s) =>
        s.withDopSettings([AZURE]).withPatResponse('my-azure', {
          status: 400,
          message: "personal access token for 'my-azure' is missing",
        }),
      );

      const result = await harness.run('import --all', { extraEnv: { CI: 'true' } });

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        `${server.baseUrl()}/projects/create?mode=azure,`,
      );
      expect(
        server.getRecordedRequests().filter((r) => r.path.startsWith('/projects/create')),
      ).toHaveLength(0);
    });

    it('never sends a token-like parameter when checking', async () => {
      const server = await startServer((s) => s.withDopSettings([GITLAB]));

      await harness.run('import --non-interactive --all');

      const checks = server.getRecordedRequests().filter((r) => r.path.endsWith('/check_pat'));
      expect(checks).toHaveLength(1);
      expect(Object.keys(checks[0].query)).toEqual(['almSetting']);
    });

    it('checks GitHub through the organizations probe and adds dopSetting to the URL', async () => {
      const server = await startServer((s) =>
        s.withDopSettings([GITHUB]).withPatResponse('my-github', {
          status: 400,
          message: 'No personal access token found',
        }),
      );

      const result = await harness.run('import --non-interactive --all');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        `${server.baseUrl()}/projects/create?mode=github&dopSetting=gh-id,`,
      );
      const paths = server.getRecordedRequests().map((r) => r.path);
      expect(paths).toContain('/api/alm_integration/list_github_organizations');
      expect(paths).not.toContain('/api/alm_integration/check_pat');
    });

    it('explains the missing permission on a 403', async () => {
      await startServer((s) =>
        s.withDopSettings([GITLAB]).withPatResponse('my-gitlab', { status: 403 }),
      );

      const result = await harness.run('import --non-interactive --all');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain("'Create Projects' permission");
    });

    it('reports a setting that disappeared on a 404', async () => {
      await startServer((s) =>
        s.withDopSettings([GITLAB]).withPatResponse('my-gitlab', { status: 404 }),
      );

      const result = await harness.run('import --non-interactive --all');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        "DevOps platform setting 'my-gitlab' was not found.",
      );
    });

    it('continues past the gate when the token works', async () => {
      await startServer((s) => s.withDopSettings([GITLAB]).withGitlabRepos('my-gitlab', []));

      const result = await harness.run('import --non-interactive --all');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        'No repositories found for this DevOps platform.',
      );
    });

    it('requires a selection flag when prompts are off, before contacting the server', async () => {
      const server = await startServer((s) => s.withDopSettings([GITLAB]));

      const result = await harness.run('import --non-interactive');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain(
        '--repo, --all, or --regex is required in non-interactive mode',
      );
      expect(server.getRecordedRequests().some((r) => r.path.includes('dop-settings'))).toBe(false);
    });
  });

  describe('older servers', () => {
    it('reports the detected version when the dop-settings API is missing', async () => {
      await startServer((s) => s.withDopSettingsError(404).withVersion('9.9.0.65466'));

      const result = await harness.run('import --all');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('does not support importing repositories');
      expect(output).toContain('Detected server version: 9.9.0.65466.');
    });

    it('explains the missing permission when listing settings is forbidden', async () => {
      await startServer((s) => s.withDopSettingsError(403));

      const result = await harness.run('import --all');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain("'Create Projects' permission");
    });
  });

  it('rejects --dop-setting on SonarQube Cloud with exit 2', async () => {
    const server = await harness.newFakeServer().withAuthToken('test-token').start();
    harness.withAuth(server.baseUrl(), 'test-token', 'my-org');

    const result = await harness.run('import --dop-setting x', {
      extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl() },
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout + result.stderr).toContain(
      '--dop-setting is only supported on SonarQube Server.',
    );
  });
});
