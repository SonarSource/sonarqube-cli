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

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { onboardCiGitlab } from '@/commands/admin/onboard-ci/gitlab/index.ts';
import { onboardCiGitlabServerSide } from '@/commands/admin/onboard-ci/gitlab/server-side.ts';
import type { OnboardCiGitlabOptions } from '@/commands/admin/onboard-ci/gitlab/types.ts';
import { TriggerOn } from '@/commands/admin/onboard-ci/gitlab/types.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import { FakeConsole } from '../../../../../_common/fake-console.ts';
import { stubIsTTY } from '../../../../../_common/tty.ts';
import { fakeResponse } from '../../../../helpers/mock-fetch.ts';

const SERVER_URL = 'https://sonarqube.example.com';
const BASE_PATH = '/api/v2/onboarding/ci-configuration';
const RUNS_PATH = `${BASE_PATH}/runs`;
const CAPABILITIES_PATH = `${BASE_PATH}/capabilities`;
const RUN_ID = 'run-1';
const RUN_PATH = `${RUNS_PATH}/${RUN_ID}`;
const GITLAB_TOKEN = 'glpat-super-secret';
const POLL_INTERVAL_MS = 1;
const REPORT = 'sonar-onboard-ci-report.json';
const DRY_REPORT = 'sonar-onboard-ci-report-dry.json';

interface RecordedRequest {
  method: string;
  path: string;
  search: URLSearchParams;
  body?: string;
}

interface ServerConfig {
  probeStatus?: number;
  capabilities?: Record<string, unknown>;
  createResponse?: Response;
  runs?: Array<Record<string, unknown>>;
  itemPages?: Array<Record<string, unknown>>;
  onRunPoll?: (pollIndex: number) => void;
}

function run(status: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    provider: 'GITLAB',
    dopSettingKey: 'my-gitlab',
    dryRun: false,
    status,
    counts: { total: 2, queued: 0, running: 0, opened: 0, wouldOpen: 0, skipped: 0, failed: 0 },
    ...overrides,
  };
}

function itemsPage(items: unknown[], total = items.length, pageIndex = 1, pageSize = 100) {
  return { items, page: { pageIndex, pageSize, total } };
}

function item(
  repository: string,
  status: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    repository,
    projectKey: repository.split('/').at(-1),
    status,
    skipReason: null,
    mergeRequestUrl: null,
    error: null,
    ...overrides,
  };
}

let fetchSpy: ReturnType<typeof spyOn>;

function installFakeServer(config: ServerConfig): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  const runs = config.runs ?? [run('COMPLETED')];
  let runPolls = 0;

  const respond = (request: RecordedRequest): Response => {
    const { method, path } = request;
    if (path === CAPABILITIES_PATH && method === 'GET') {
      return fakeResponse(
        config.capabilities ?? { runs: true, status: true, providers: ['GITLAB'] },
        { status: config.probeStatus ?? 200 },
      );
    }
    if (path === RUNS_PATH && method === 'POST') {
      return (
        config.createResponse ?? fakeResponse({ id: RUN_ID, status: 'QUEUED' }, { status: 202 })
      );
    }
    if (path === RUN_PATH && method === 'GET') {
      const pollIndex = runPolls++;
      config.onRunPoll?.(pollIndex);
      return fakeResponse(runs[Math.min(pollIndex, runs.length - 1)]);
    }
    if (path === `${RUN_PATH}/items`) {
      const pageIndex = Number(request.search.get('pageIndex') ?? '1');
      return fakeResponse((config.itemPages ?? [itemsPage([])])[pageIndex - 1]);
    }
    if (path === `${RUN_PATH}/cancel` && method === 'POST') {
      return fakeResponse(undefined, { status: 204 });
    }
    if (path === '/api/users/current') {
      return fakeResponse({ permissions: { global: [] } });
    }
    return fakeResponse({}, { status: 404 });
  };

  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((
    input: unknown,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      search: url.searchParams,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    requests.push(request);
    return Promise.resolve(respond(request));
  }) as typeof fetch);

  return requests;
}

function connection(): SonarConnection {
  return {
    auth: new ResolvedAuth({
      token: 'squ_token',
      serverUrl: SERVER_URL,
      connectionType: 'on-premise',
      source: 'state',
    }),
    httpClient: new SonarHttpClient(SERVER_URL, 'squ_token'),
  };
}

function options(overrides: Partial<OnboardCiGitlabOptions> = {}): OnboardCiGitlabOptions {
  return {
    group: 'acme',
    sonarTokenVarName: 'SONAR_TOKEN',
    triggerOn: TriggerOn.Both,
    allowFailure: false,
    dryRun: false,
    scannerProperty: [],
    ...overrides,
  };
}

function createBody(requests: RecordedRequest[]): Record<string, unknown> {
  const create = requests.find((r) => r.method === 'POST' && r.path === RUNS_PATH);
  return JSON.parse(create?.body ?? '{}') as Record<string, unknown>;
}

function runServerSide(
  console: FakeConsole,
  opts: OnboardCiGitlabOptions,
  jobTemplateContent?: string,
): Promise<void> {
  return onboardCiGitlabServerSide(connection(), GITLAB_TOKEN, opts, console, {
    jobTemplateContent,
    pollIntervalMs: POLL_INTERVAL_MS,
  });
}

function readReport(dir: string, name: string): unknown {
  return JSON.parse(readFileSync(join(dir, name), 'utf8'));
}

describe('onboard-ci gitlab server-side execution', () => {
  let console: FakeConsole;
  let workDir: string;
  let originalCwd: string;
  let restoreTTY: () => void;

  beforeEach(() => {
    console = new FakeConsole();
    originalCwd = process.cwd();
    workDir = mkdtempSync(join(tmpdir(), 'onboard-ci-server-side-'));
    process.chdir(workDir);
    restoreTTY = stubIsTTY(false, process.stdout);
  });

  afterEach(() => {
    restoreTTY();
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
    fetchSpy?.mockRestore();
  });

  describe('live run', () => {
    it('builds the report and outro from the run items', async () => {
      installFakeServer({
        runs: [run('RUNNING'), run('COMPLETED')],
        itemPages: [
          itemsPage([
            item('acme/svc1', 'OPENED', { mergeRequestUrl: 'https://gitlab/mr/1' }),
            item('acme/svc2', 'SKIPPED', { skipReason: 'ALREADY_CONFIGURED' }),
            item('acme/svc3', 'SKIPPED', {
              skipReason: 'MR_ALREADY_OPEN',
              mergeRequestUrl: 'https://gitlab/mr/3',
            }),
          ]),
        ],
      });

      await runServerSide(console, options());

      expect(console.findCall('outro', 'Opened 1 MRs · 2 skipped · 0 failed')?.args[1]).toBe(
        'success',
      );
      expect(readReport(workDir, REPORT)).toEqual({
        opened: [{ repo: 'acme/svc1', projectKey: 'svc1', mrUrl: 'https://gitlab/mr/1' }],
        skipped: [
          { repo: 'acme/svc2', reason: 'ALREADY_CONFIGURED' },
          { repo: 'acme/svc3', reason: 'MR_ALREADY_OPEN', mrUrl: 'https://gitlab/mr/3' },
        ],
        failed: [],
      });
      expect(console.findCall('print', 'Full report: sonar-onboard-ci-report.json')).toBeDefined();
    });

    it('fails with the usual error when items failed', async () => {
      installFakeServer({
        itemPages: [
          itemsPage([item('acme/svc1', 'OPENED'), item('acme/svc2', 'FAILED', { error: 'boom' })]),
        ],
      });

      const failure = await runServerSide(console, options()).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CommandFailedError);
      expect((failure as CommandFailedError).message).toBe('1 repositories failed to process.');
      expect(console.findCall('outro', 'Opened 1 MRs · 0 skipped · 1 failed')?.args[1]).toBe(
        'error',
      );
      expect((readReport(workDir, REPORT) as { failed: unknown }).failed).toEqual([
        { repo: 'acme/svc2', error: 'boom' },
      ]);
    });

    it('fetches every items page', async () => {
      const requests = installFakeServer({
        itemPages: [
          itemsPage([item('acme/a', 'OPENED'), item('acme/b', 'OPENED')], 3, 1, 2),
          itemsPage([item('acme/c', 'OPENED')], 3, 2, 2),
        ],
      });

      await runServerSide(console, options());

      const itemRequests = requests.filter((r) => r.path.endsWith('/items'));
      expect(itemRequests.map((r) => r.search.get('pageIndex'))).toEqual(['1', '2']);
      expect((readReport(workDir, REPORT) as { opened: unknown[] }).opened).toHaveLength(3);
    });

    it('fails without a report when the run itself failed', async () => {
      installFakeServer({ runs: [run('FAILED', { error: 'cannot list group acme' })] });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(runServerSide(console, options())).rejects.toThrow(
        'CI configuration run failed: cannot list group acme',
      );
      expect(existsSync(join(workDir, REPORT))).toBe(false);
    });

    it('polls until the run is terminal', async () => {
      const requests = installFakeServer({
        runs: [run('QUEUED'), run('RUNNING'), run('COMPLETED')],
      });

      await runServerSide(console, options());

      expect(requests.filter((r) => r.path === RUN_PATH)).toHaveLength(3);
    });
  });

  describe('dry run', () => {
    it('writes the dry-run report and sends dryRun', async () => {
      const requests = installFakeServer({
        runs: [run('COMPLETED', { dryRun: true })],
        itemPages: [
          itemsPage([
            item('acme/svc1', 'WOULD_OPEN'),
            item('acme/svc2', 'SKIPPED', { skipReason: 'OTHER_CI_DETECTED' }),
            item('acme/svc3', 'FAILED', { error: 'nope' }),
          ]),
        ],
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(runServerSide(console, options({ dryRun: true }))).rejects.toThrow(
        '1 repositories failed to process.',
      );

      expect(createBody(requests).dryRun).toBe(true);
      expect(readReport(workDir, DRY_REPORT)).toEqual({
        wouldOpenMr: [{ repo: 'acme/svc1', projectKey: 'svc1' }],
        wouldSkip: [{ repo: 'acme/svc2', reason: 'OTHER_CI_DETECTED' }],
        failed: [{ repo: 'acme/svc3', error: 'nope' }],
      });
      expect(console.findCall('outro', 'Opened 1 MRs · 1 skipped · 1 failed')?.args[2]).toBe(
        'No changes were made',
      );
      expect(existsSync(join(workDir, REPORT))).toBe(false);
    });
  });

  describe('request mapping', () => {
    it('maps the options to the create request', async () => {
      const requests = installFakeServer({});

      await runServerSide(
        console,
        options({
          bindingName: 'my-gitlab',
          repos: 'team-a/svc1, team-b/svc2',
          triggerOn: TriggerOn.Mr,
          stage: 'verify',
          allowFailure: true,
          sonarTokenVarName: 'MY_TOKEN',
          scannerProperty: ['sonar.foo=bar'],
        }),
      );

      expect(createBody(requests)).toEqual({
        provider: 'GITLAB',
        dopSettingKey: 'my-gitlab',
        selection: { groupPath: 'acme', repoPaths: ['team-a/svc1', 'team-b/svc2'] },
        options: {
          serverUrl: SERVER_URL,
          triggerOn: 'MR',
          stage: 'verify',
          allowFailure: true,
          sonarTokenVarName: 'MY_TOKEN',
          scannerProperties: ['sonar.foo=bar'],
        },
        dryRun: false,
        credential: { type: 'PERSONAL_ACCESS_TOKEN', token: GITLAB_TOKEN },
      });
    });

    it('sends only the job template and server URL in template mode', async () => {
      const requests = installFakeServer({});

      await runServerSide(console, options(), 'job:\n  script: scan {{SONAR_PROJECT_KEY}}\n');

      expect(createBody(requests).options).toEqual({
        serverUrl: SERVER_URL,
        jobTemplate: 'job:\n  script: scan {{SONAR_PROJECT_KEY}}\n',
      });
    });

    it('omits the selection filter and binding name when not given', async () => {
      const requests = installFakeServer({});

      await runServerSide(console, options());

      const body = createBody(requests);
      expect(body.selection).toEqual({ groupPath: 'acme' });
      expect(body).not.toHaveProperty('dopSettingKey');
    });

    it('reads the repositories of --repos-file', async () => {
      const reposFile = join(workDir, 'repos.txt');
      writeFileSync(reposFile, '# comment\nteam-a/svc1\n\nteam-b/svc2\n');
      const requests = installFakeServer({});

      await runServerSide(console, options({ reposFile }));

      expect(createBody(requests).selection).toEqual({
        groupPath: 'acme',
        repoPaths: ['team-a/svc1', 'team-b/svc2'],
      });
    });

    it('refuses an empty --repos-file instead of processing the whole group', async () => {
      const reposFile = join(workDir, 'repos.txt');
      writeFileSync(reposFile, '# nothing here\n');
      const requests = installFakeServer({});

      const failure = await runServerSide(console, options({ reposFile })).catch(
        (error: unknown) => error,
      );

      expect((failure as CommandFailedError).exitCode).toBe(2);
      expect(requests.some((r) => r.method === 'POST')).toBe(false);
    });
  });

  describe('create errors', () => {
    it('maps a 400 to a CommandFailedError with exit code 2 and the server message', async () => {
      installFakeServer({
        createResponse: fakeResponse(
          { message: 'No GitLab configuration found in SonarQube.' },
          { status: 400 },
        ),
      });

      const failure = await runServerSide(console, options()).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CommandFailedError);
      expect((failure as CommandFailedError).exitCode).toBe(2);
      expect((failure as CommandFailedError).message).toBe(
        'No GitLab configuration found in SonarQube.',
      );
    });

    it('never surfaces the GitLab token, even if the server echoes it', async () => {
      installFakeServer({
        createResponse: fakeResponse(
          { message: `Token ${GITLAB_TOKEN} is invalid` },
          { status: 400 },
        ),
      });

      const failure = await runServerSide(console, options()).catch((error: unknown) => error);

      expect((failure as Error).message).not.toContain(GITLAB_TOKEN);
    });

    it('maps a 403 to the Provision Projects message', async () => {
      installFakeServer({ createResponse: fakeResponse('forbidden', { status: 403 }) });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(runServerSide(console, options())).rejects.toThrow('Provision Projects');
    });
  });

  describe('cancellation', () => {
    it('cancels the run on Ctrl-C and reports the cancelled repositories', async () => {
      const requests = installFakeServer({
        runs: [run('RUNNING'), run('CANCELLED')],
        itemPages: [
          itemsPage([
            item('acme/svc1', 'OPENED'),
            item('acme/svc2', 'SKIPPED', { error: 'cancelled' }),
          ]),
        ],
        onRunPoll: (pollIndex) => {
          if (pollIndex === 0) process.emit('SIGINT');
        },
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(runServerSide(console, options())).rejects.toThrow(
        'cancelled before it completed',
      );

      expect(
        requests.filter((r) => r.method === 'POST' && r.path === `${RUN_PATH}/cancel`),
      ).toHaveLength(1);
      expect((readReport(workDir, REPORT) as { failed: unknown }).failed).toEqual([
        { repo: 'acme/svc2', error: 'cancelled' },
      ]);
    });

    it('removes its SIGINT listener when done', async () => {
      installFakeServer({});
      const before = process.listenerCount('SIGINT');

      await runServerSide(console, options());

      expect(process.listenerCount('SIGINT')).toBe(before);
    });
  });

  describe('token handling', () => {
    it('only sends the token in the create request body', async () => {
      const requests = installFakeServer({
        itemPages: [itemsPage([item('acme/svc1', 'OPENED')])],
      });

      await runServerSide(console, options());

      const withToken = requests.filter((r) => JSON.stringify(r).includes(GITLAB_TOKEN));
      expect(withToken.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${RUNS_PATH}`]);
      expect(JSON.stringify(console.calls)).not.toContain(GITLAB_TOKEN);
      expect(readFileSync(join(workDir, REPORT), 'utf8')).not.toContain(GITLAB_TOKEN);
    });
  });
});

describe('onboard-ci gitlab mode selection', () => {
  let console: FakeConsole;
  let restoreTTY: () => void;
  let workDir: string;
  let originalCwd: string;

  beforeEach(() => {
    console = new FakeConsole();
    originalCwd = process.cwd();
    workDir = mkdtempSync(join(tmpdir(), 'onboard-ci-mode-'));
    process.chdir(workDir);
    restoreTTY = stubIsTTY(false, process.stdout);
  });

  afterEach(() => {
    restoreTTY();
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
    fetchSpy?.mockRestore();
  });

  const created = (requests: RecordedRequest[]) =>
    requests.some((r) => r.method === 'POST' && r.path === RUNS_PATH);

  it('uses the server-side path by default when the probe succeeds', async () => {
    const requests = installFakeServer({});

    await onboardCiGitlab(connection(), GITLAB_TOKEN, options(), console);

    expect(created(requests)).toBe(true);
    expect(console.findCall('info', 'server-side')).toBeDefined();
  });

  it.each([403, 404, 405])(
    'falls back to the client-side path when the probe returns %i',
    async (status) => {
      const requests = installFakeServer({ probeStatus: status });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(onboardCiGitlab(connection(), GITLAB_TOKEN, options(), console)).rejects.toThrow(
        'Provision Projects',
      );

      expect(created(requests)).toBe(false);
      expect(requests.some((r) => r.path === '/api/users/current')).toBe(true);
      expect(console.findCall('info', 'client-side')).toBeDefined();
    },
  );

  it('falls back to the client-side path when runs are disabled', async () => {
    const requests = installFakeServer({
      capabilities: { runs: false, status: true, providers: ['GITLAB'] },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(onboardCiGitlab(connection(), GITLAB_TOKEN, options(), console)).rejects.toThrow(
      'Provision Projects',
    );

    expect(created(requests)).toBe(false);
    expect(console.findCall('info', 'client-side')).toBeDefined();
  });

  it('falls back to the client-side path when GITLAB is not a supported provider', async () => {
    const requests = installFakeServer({
      capabilities: { runs: true, status: true, providers: [] },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(onboardCiGitlab(connection(), GITLAB_TOKEN, options(), console)).rejects.toThrow(
      'Provision Projects',
    );

    expect(created(requests)).toBe(false);
  });

  it.each([
    ['the endpoint is missing', { probeStatus: 404 }],
    ['runs are disabled', { capabilities: { runs: false, status: true, providers: ['GITLAB'] } }],
  ])('--server-side fails clearly when %s', async (_label, config) => {
    const requests = installFakeServer(config);

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      onboardCiGitlab(connection(), GITLAB_TOKEN, options({ serverSide: true }), console),
    ).rejects.toThrow('Server-side CI configuration is not enabled on this SonarQube instance.');

    expect(created(requests)).toBe(false);
  });

  it('--server-side uses the server-side path when supported', async () => {
    const requests = installFakeServer({});

    await onboardCiGitlab(connection(), GITLAB_TOKEN, options({ serverSide: true }), console);

    expect(created(requests)).toBe(true);
  });

  it('--client-side never probes or calls the runs API', async () => {
    const requests = installFakeServer({});

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      onboardCiGitlab(connection(), GITLAB_TOKEN, options({ clientSide: true }), console),
    ).rejects.toThrow('Provision Projects');

    expect(requests.some((r) => r.path.startsWith(BASE_PATH))).toBe(false);
  });

  it('propagates probe failures other than 403, 404 and 405', async () => {
    installFakeServer({ probeStatus: 500 });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(onboardCiGitlab(connection(), GITLAB_TOKEN, options(), console)).rejects.toThrow();
  });
});
