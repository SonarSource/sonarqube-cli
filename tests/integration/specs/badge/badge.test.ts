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

import { type FakeSonarQubeServer, TestHarness } from '../../harness';

const LOGIN_TOKEN = 'login-credential-never-in-output';
const BADGE_TOKEN = 'badge &/?"secret';
const PROJECT = 'my-org_my-app';
const PROMPT = 'Generate badges for this private project?';

interface BadgePayload {
  project: string;
  branch?: string;
  badges: Array<{
    metric: string;
    label: string;
    imageUrl: string;
    projectUrl: string;
    markdown: string;
    html: string;
  }>;
}

const CATALOG = [
  ['quality-gate', 'alert_status', 'Quality Gate Status'],
  ['coverage', 'coverage', 'Coverage'],
  ['bugs', 'bugs', 'Bugs'],
  ['vulnerabilities', 'vulnerabilities', 'Vulnerabilities'],
  ['code-smells', 'code_smells', 'Code Smells'],
  ['security-hotspots', 'security_hotspots', 'Security Hotspots'],
  ['duplications', 'duplicated_lines_density', 'Duplications'],
  ['lines', 'ncloc', 'Lines of Code'],
  ['maintainability-rating', 'sqale_rating', 'Maintainability Rating'],
  ['reliability-rating', 'reliability_rating', 'Reliability Rating'],
  ['security-rating', 'security_rating', 'Security Rating'],
  ['technical-debt', 'sqale_index', 'Technical Debt'],
];

describe('badge', () => {
  let harness: TestHarness;
  beforeEach(async () => {
    harness = await TestHarness.create();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  async function setup(
    options: {
      cloud?: boolean;
      region?: 'eu' | 'us';
      visibility?: string;
      qualifier?: string;
      token?: unknown;
      tokenStatus?: number;
      organization?: string;
      componentStatus?: number;
    } = {},
  ): Promise<FakeSonarQubeServer> {
    const builder = harness
      .newFakeServer()
      .withAuthToken(LOGIN_TOKEN)
      .withOrganizations([{ key: 'my-org', name: 'My Organization' }])
      .withProject(PROJECT, (p) => {
        p.withBadge({
          visibility: options.visibility ?? 'public',
          qualifier: options.qualifier ?? 'TRK',
          token: options.token === undefined ? BADGE_TOKEN : options.token,
          tokenStatus: options.tokenStatus,
        }).withOrganization(options.organization ?? 'my-org');
        if (options.componentStatus) p.withComponentShowError(options.componentStatus);
      });
    if (options.cloud) builder.asSonarCloud();
    const server = await builder.start();
    const region = options.region ?? 'eu';
    harness.withAuth(
      server.recordedAuthServerUrl(region),
      LOGIN_TOKEN,
      options.cloud ? 'my-org' : undefined,
    );
    if (region === 'us')
      harness.withExtraEnv({
        SONARQUBE_CLI_SONARCLOUD_US_URL: server.baseUrl(),
        SONARQUBE_CLI_SONARCLOUD_US_API_URL: server.baseUrl(),
      });
    return server;
  }

  function tokenRequests(server: FakeSonarQubeServer) {
    return server
      .getRecordedRequests()
      .filter((r) => ['/api/navigation/component', '/api/project_badges/token'].includes(r.path));
  }

  it('prints default Markdown using silent discovery, with a final newline', async () => {
    const server = await setup();
    harness.cwd.writeFile(
      '.sonar-config.json',
      JSON.stringify({
        projects: [{ projectKey: PROJECT, serverUrl: server.baseUrl(), path: '.' }],
      }),
    );
    const result = await harness.run('badge');
    const image = `${server.baseUrl()}/api/project_badges/measure?project=${PROJECT}&metric=alert_status&token=${encodeURIComponent(BADGE_TOKEN).replaceAll('%20', '+')}`;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `[![Quality Gate Status](${image})](${server.baseUrl()}/dashboard?id=${PROJECT})\n`,
    );
    expect(result.stderr).toBe('');
    expect(tokenRequests(server)[0]?.query).toEqual({ project: PROJECT });
    expect(result.stdout).not.toContain(LOGIN_TOKEN);
  });

  it('honors --project over discovery and preserves a supplied branch in both links', async () => {
    await setup();
    harness.cwd.writeFile(
      '.sonar-config.json',
      JSON.stringify({ projects: [{ projectKey: 'wrong-project' }] }),
    );
    const result = await harness.run(
      `badge -p ${PROJECT} --branch 'feature/a & "b"' --format json`,
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as BadgePayload;
    expect(payload.project).toBe(PROJECT);
    expect(payload.branch).toBe('feature/a & "b"');
    for (const link of [payload.badges[0].imageUrl, payload.badges[0].projectUrl])
      expect(new URL(link).searchParams.get('branch')).toBe('feature/a & "b"');
    expect(payload.badges[0].html).toContain('&amp;');
    expect(payload.badges[0].html).not.toContain(' & ');
  });

  it('preserves a Server context path and encodes project keys', async () => {
    const project = 'org:app &/"<readme>';
    const server = await harness
      .newFakeServer()
      .withContextPath('/sonarqube')
      .withAuthToken(LOGIN_TOKEN)
      .withProject(project)
      .start();
    harness.withAuth(server.baseUrl(), LOGIN_TOKEN);
    const result = await harness.run(`badge -p '${project}' --format json`);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as BadgePayload;
    const image = new URL(payload.badges[0].imageUrl);
    const target = new URL(payload.badges[0].projectUrl);
    expect(image.pathname).toBe('/sonarqube/api/project_badges/measure');
    expect(image.searchParams.get('project')).toBe(project);
    expect(target.pathname).toBe('/sonarqube/dashboard');
    expect(target.searchParams.get('id')).toBe(project);
    expect(payload.badges[0].html).not.toContain('<readme>');
    expect(
      server
        .getRecordedRequests()
        .every((request) => new URL(request.url).pathname.startsWith('/sonarqube/')),
    ).toBe(true);
  });

  it.each(['eu', 'us'] as const)(
    'keeps the %s Cloud host, omits public tokens and defaults to the main branch',
    async (region) => {
      const server = await setup({ cloud: true, region });
      const result = await harness.run(`badge -p ${PROJECT} --format json`);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as BadgePayload;
      expect(payload).not.toHaveProperty('branch');
      const badge = payload.badges[0];
      const host = region === 'eu' ? 'https://sonarcloud.io' : 'https://sonarqube.us';
      expect(badge.imageUrl).toBe(
        `${host}/api/project_badges/measure?project=${PROJECT}&metric=alert_status`,
      );
      expect(badge.projectUrl).toBe(`${host}/summary/new_code?id=${PROJECT}`);
      expect(tokenRequests(server)).toEqual([]);
      expect(result.stdout).not.toContain(LOGIN_TOKEN);
    },
  );

  it.each([false, true])('expands all metrics in order for cloud=%s', async (cloud) => {
    await setup({ cloud });
    const result = await harness.run(
      `badge -p ${PROJECT} -m 'coverage, all' -m quality-gate,coverage --format json`,
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as BadgePayload;
    const catalog = CATALOG.filter(([name]) => !cloud || name !== 'security-hotspots');
    const expected = [catalog[1], ...catalog.filter(([name]) => name !== 'coverage')];
    expect(
      payload.badges.map((b) => [
        b.metric,
        new URL(b.imageUrl).searchParams.get('metric'),
        b.label,
      ]),
    ).toEqual(expected);
  });

  it.each(['quality-gate,,coverage', ',', ' ', 'unknown', 'all,unknown', 'all,security-hotspots'])(
    'rejects invalid Cloud metrics %s with empty stdout',
    async (metric) => {
      const server = await setup({ cloud: true });
      const result = await harness.run(`badge -p ${PROJECT} -m '${metric}'`);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(tokenRequests(server)).toEqual([]);
    },
  );

  it.each(['markdown', 'html', 'url'] as const)(
    'prints exactly one %s badge per line',
    async (format) => {
      await setup();
      const command = `badge -p ${PROJECT} -m quality-gate,coverage`;
      const json = await harness.run(`${command} --format json`);
      const payload = JSON.parse(json.stdout) as BadgePayload;
      const result = await harness.run(`${command} --format ${format}`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        payload.badges.map((b) => (format === 'url' ? b.imageUrl : b[format])).join('\n') + '\n',
      );
      expect(payload.badges[0].html).toBe(
        `<a href="${payload.badges[0].projectUrl}"><img alt="Quality Gate Status" src="${payload.badges[0].imageUrl.replaceAll('&', '&amp;')}"></a>`,
      );
    },
  );

  it.each([false, true])(
    'uses the backend badge token after explicit private consent, cloud=%s',
    async (cloud) => {
      const server = await setup({ cloud, visibility: 'private' });
      const result = await harness.run(
        `badge -p ${PROJECT} --allow-private --non-interactive --format json`,
      );
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as BadgePayload;
      expect(new URL(payload.badges[0].imageUrl).searchParams.get('token')).toBe(BADGE_TOKEN);
      expect(result.stderr).toContain('including the security rating, beyond the selected badges');
      expect(result.stderr).toContain('trusted environments');
      expect(result.stdout).not.toContain(LOGIN_TOKEN);
      expect(tokenRequests(server).map((r) => r.path)).toEqual([
        cloud ? '/api/navigation/component' : '/api/project_badges/token',
      ]);
      expect(tokenRequests(server)[0].query).toEqual(
        cloud ? { component: PROJECT } : { project: PROJECT },
      );
    },
  );

  it.each(['', '--non-interactive'])(
    'requires private consent with telemetry and closed stdin (%s)',
    async (flag) => {
      const server = await setup({ cloud: true, visibility: 'private' });
      harness.state().withTelemetryEnabled();
      const result = await harness.run(`badge -p ${PROJECT} ${flag}`);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('--allow-private');
      expect(tokenRequests(server)).toEqual([]);
    },
  );

  it.each(['accept', 'decline', 'default-no', 'cancel'] as const)(
    'supports private interactive %s on stderr with telemetry',
    async (answer) => {
      const server = await setup({ cloud: true, visibility: 'private' });
      harness.state().withTelemetryEnabled();
      const session = harness.runInteractive(`badge -p ${PROJECT} --format json`, {
        promptChannel: 'stderr',
        extraEnv: { SONARQUBE_CLI_MOCK_TTY: '1', CI: 'false' },
      });
      await session.waitText(PROMPT);
      if (answer === 'cancel') session.keyCtrlC();
      else if (answer === 'default-no') session.keyEnter();
      else session.write(answer === 'accept' ? 'y' : 'n');
      const result = await session.waitFinish();
      expect(result.exitCode).toBe(answer === 'cancel' ? 1 : 0);
      expect(result.stderr).toContain(PROMPT);
      if (answer === 'accept') {
        expect((JSON.parse(result.stdout) as BadgePayload).badges).toHaveLength(1);
        expect(tokenRequests(server).length).toBeGreaterThan(0);
      } else {
        expect(result.stdout).toBe('');
        expect(tokenRequests(server)).toEqual([]);
        expect(result.stderr).toContain(
          answer === 'cancel' ? 'cancelled' : 'No badges were generated',
        );
      }
    },
  );

  it.each(['internal', ''])('fails closed for unknown visibility %s', async (visibility) => {
    const server = await setup({ visibility });
    const result = await harness.run(`badge -p ${PROJECT} --allow-private`);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('visibility');
    expect(tokenRequests(server)).toEqual([]);
  });

  it.each(['FIL', 'APP'])('rejects non-project component %s', async (qualifier) => {
    const server = await setup({ qualifier });
    const result = await harness.run(`badge -p ${PROJECT}`);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(tokenRequests(server)).toEqual([]);
  });

  it.each(['other-org', ''])(
    'rejects Cloud organization %s before consent or token retrieval',
    async (organization) => {
      const server = await setup({ cloud: true, visibility: 'private', organization });
      const result = await harness.run(`badge -p ${PROJECT} --allow-private`);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(tokenRequests(server)).toEqual([]);
    },
  );

  it.each([null, '', ' ', 123, {}])(
    'rejects missing or malformed token %j with no partial payload',
    async (token) => {
      await setup({ token });
      const result = await harness.run(`badge -p ${PROJECT} -m all`);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('badge token');
    },
  );

  it.each([401, 403, 404, 500])(
    'handles metadata HTTP %s without token retrieval',
    async (componentStatus) => {
      const server = await setup({ componentStatus });
      const result = await harness.run(`badge -p ${PROJECT}`);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(tokenRequests(server)).toEqual([]);
    },
  );

  it.each([204, 403, 404, 500])('handles token HTTP %s with empty stdout', async (tokenStatus) => {
    await setup({ tokenStatus });
    const result = await harness.run(`badge -p ${PROJECT}`);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
  });

  it.each([{}, { qualifier: 'TRK' }, { qualifier: 'TRK', visibility: 'public' }])(
    'fails closed on incomplete metadata or missing token %j',
    async (config) => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(LOGIN_TOKEN)
        .withProject(PROJECT, (p) => p.withBadge(config))
        .start();
      harness.withAuth(server.baseUrl(), LOGIN_TOKEN);
      const result = await harness.run(`badge -p ${PROJECT}`);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
    },
  );

  it('keeps stdout clean when a stale installation runs startup migrations', async () => {
    await setup();
    harness.state().withCliVersion('0.5.0');
    const result = await harness.run(`badge -p ${PROJECT} --format url`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.stdout).toStartWith('http://localhost:');
    expect(harness.stateJsonFile.asJson().config.cliVersion).not.toBe('0.5.0');
  });

  it('fails without an authenticated connection', async () => {
    const result = await harness.run(`badge -p ${PROJECT}`);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('fails without a project and rejects invalid formats', async () => {
    await setup();
    const missing = await harness.run('badge');
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('--project');
    const format = await harness.run(`badge -p ${PROJECT} --format text`);
    expect(format.exitCode).toBe(1);
    expect(format.stdout).toBe('');
  });
});
