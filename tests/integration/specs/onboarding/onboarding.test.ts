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

import { TestHarness } from '../../harness';

const OWNER = 'hackathon';
const ORGANIZATION = {
  key: OWNER,
  name: 'Hackathon',
  alm: { key: 'github', url: `https://github.com/${OWNER}` },
  actions: { admin: true },
};
const FREE_PLAN = [
  {
    name: 'Free_v2',
    tiers: [
      {
        priceId: 'free-price',
        currencyOptions: [{ unitAmount: 0 }],
      },
    ],
  },
];

describe('Cloud onboarding', () => {
  let harness: TestHarness;
  let server: ReturnType<typeof Bun.serve>;
  let requests: { method: string; path: string; query: URLSearchParams; body: string }[];
  let bound: boolean;
  let existingOrganization: boolean;
  let otherBinding: boolean;
  let subscribed: boolean;
  let installation: boolean;
  let admin: boolean;
  let planAmount: number;
  let eligibilityStatus: number;
  let eligibility: boolean;
  let analysesReady: boolean;
  let installAfterRequest: number;
  let linkedProjects: { key: string; name: string }[];
  let subscriptionFailures: number;
  let discoveryError: string | undefined;
  let forbidEmptySubscriptionRead: boolean;
  let trial: boolean;
  let reportedTrial: boolean;
  let trialEnd: string;
  let rejectTrial: boolean;
  let paymentMethodStatus: string;
  let userEmail: string | undefined;
  let acceptedLoginToken: string | undefined;

  beforeEach(async () => {
    harness = await TestHarness.create();
    requests = [];
    bound = false;
    existingOrganization = false;
    otherBinding = false;
    subscribed = false;
    installation = true;
    admin = true;
    planAmount = 0;
    eligibilityStatus = 200;
    eligibility = true;
    analysesReady = true;
    installAfterRequest = 0;
    linkedProjects = [{ key: 'hackathon_repo', name: 'repo' }];
    subscriptionFailures = 0;
    discoveryError = undefined;
    forbidEmptySubscriptionRead = false;
    trial = false;
    reportedTrial = true;
    trialEnd = new Date(Date.now() + 14 * 86400000).toISOString();
    rejectTrial = false;
    paymentMethodStatus = 'NONE';
    userEmail = 'tester@example.test';
    acceptedLoginToken = undefined;
    server = Bun.serve({
      port: 0,
      hostname: 'localhost',
      async fetch(request) {
        const url = new URL(request.url);
        const body = request.method === 'POST' ? await request.text() : '';
        requests.push({
          method: request.method,
          path: url.pathname,
          query: url.searchParams,
          body,
        });
        switch (url.pathname) {
          case '/api/authentication/validate':
            return Response.json({
              valid:
                acceptedLoginToken === undefined ||
                request.headers.get('authorization') === `Bearer ${acceptedLoginToken}`,
            });
          case '/api/users/current':
            return Response.json({ login: 'tester', name: 'Tester', email: userEmail });
          case '/api/organizations/search':
            if (url.searchParams.has('organizations') && existingOrganization)
              return Response.json({
                organizations: [
                  {
                    key: OWNER,
                    name: 'Existing workspace',
                    actions: { admin },
                    ...(otherBinding
                      ? { alm: { key: 'github', url: 'https://github.com/other-owner' } }
                      : {}),
                  },
                ],
              });
            return Response.json({
              organizations: bound ? [{ ...ORGANIZATION, actions: { admin } }] : [],
              paging: { total: bound ? 1 : 0, pageIndex: 1, pageSize: 100 },
            });
          case '/api/alm_integration/bind_organization':
            bound = true;
            return new Response(null, { status: 204 });
          case '/api/alm_integration/list_unbound_applications': {
            if (discoveryError)
              return Response.json({ errors: [{ msg: discoveryError }] }, { status: 400 });
            const count = requests.filter((r) => r.path === url.pathname).length;
            if (installAfterRequest && count >= installAfterRequest) installation = true;
            return Response.json({
              applications: installation
                ? [{ key: OWNER, name: 'Hackathon', installationId: '1234' }]
                : [],
            });
          }
          case '/api/alm_integration/show_app_info':
            return Response.json({
              application: {
                installationUrl: 'https://github.com/apps/sonarcloud/installations/new',
              },
            });
          case '/api/alm_integration/show_dop_organization':
            return Response.json({
              almOrganization: { key: OWNER, name: 'Hackathon' },
              ...(bound ? { boundOrganization: ORGANIZATION } : {}),
            });
          case '/api/organizations/create':
            bound = true;
            return Response.json({ organization: ORGANIZATION });
          case '/organizations/organizations':
            return Response.json(
              bound ? [{ ...ORGANIZATION, id: 'legacy-org', uuidV4: 'uuid-org' }] : [],
            );
          case '/billing/plans':
            return Response.json([
              {
                name: 'Free',
                tiers: [{ priceId: 'legacy-oss-price', currencyOptions: [{ unitAmount: 0 }] }],
              },
              ...FREE_PLAN.map((plan) => ({
                ...plan,
                tiers: plan.tiers.map((tier) => ({
                  ...tier,
                  currencyOptions: [{ unitAmount: planAmount }],
                })),
              })),
            ]);
          case '/billing/subscriptions':
            if (request.method === 'POST') {
              if (subscriptionFailures-- > 0)
                return Response.json({ error: 'temporarily unavailable' }, { status: 503 });
              if (rejectTrial)
                return Response.json({ errors: [{ msg: 'Trial already used' }] }, { status: 400 });
              subscribed = true;
              trial = !Object.hasOwn(JSON.parse(body) as Record<string, unknown>, 'priceId');
              return Response.json({ planKey: trial ? 'team' : 'free_v2' });
            }
            if (forbidEmptySubscriptionRead && !subscribed)
              return Response.json(
                { errors: [{ msg: 'No readable subscription yet' }] },
                { status: 403 },
              );
            return Response.json({
              subscriptions: subscribed
                ? [
                    {
                      planKey: trial ? 'Team' : 'free_v2',
                      status: 'active',
                      trial: trial && reportedTrial,
                      ...(trial
                        ? {
                            trialPeriod: {
                              start: new Date().toISOString(),
                              end: trialEnd,
                            },
                          }
                        : {}),
                    },
                  ]
                : [],
            });
          case '/billing/customers':
            return Response.json({ paymentMethodStatus });
          case '/billing/entitlements':
            return Response.json({ entitlements: [{ allowedFeatures: ['privateProjects'] }] });
          case '/dop-translation/dop-repositories':
            return Response.json({
              repositories: [
                {
                  id: '42',
                  name: 'repo',
                  slug: `${OWNER}/repo`,
                  private: false,
                  archived: false,
                  boundProjectIds: [],
                  importedInCurrentOrg: false,
                },
              ],
              page: { total: 1 },
            });
          case '/api/alm_integration/provision_projects':
            return Response.json({ projects: [{ projectKey: 'hackathon_repo' }] });
          case '/api/alm_integration/list_repositories':
            return Response.json({
              repositories: [
                { slug: `${OWNER}/repo`, installationKey: `${OWNER}/repo|42`, linkedProjects },
              ],
            });
          case '/api/project_analyses/search':
            return Response.json({
              analyses: analysesReady ? [{ key: 'analysis-1', date: '2026-10-06T10:00:00Z' }] : [],
            });
          case '/api/autoscan/eligibility':
            if (eligibilityStatus === 202) {
              analysesReady = true;
              return new Response(null, { status: 202 });
            }
            return Response.json(
              { eligible: eligibility, ineligibilityReason: 'unsupported_languages' },
              { status: eligibilityStatus },
            );
          default:
            return Response.json({ error: 'Unknown test endpoint' }, { status: 404 });
        }
      },
    });
    const base = `http://localhost:${server.port}`;
    harness.withExtraEnv({
      SONARQUBE_CLI_SONARCLOUD_URL: base,
      SONARQUBE_CLI_SONARCLOUD_API_URL: base,
    });
    harness
      .state()
      .withActiveConnection(base, 'cloud')
      .withKeychainToken(base, 'onboarding-test-token');
  });

  afterEach(async () => {
    await harness.dispose();
    await server.stop(true);
  });

  function run(command: string) {
    return harness.run(command, { timeoutMs: 15000 });
  }

  function events(stderr: string): Record<string, unknown>[] {
    return stderr.split('\n').flatMap((line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        return event.event ? [event] : [];
      } catch {
        return [];
      }
    });
  }

  function expectEvent(stderr: string, expected: { event: string; step: string; actor?: string }) {
    const match = events(stderr).find(
      (event) => event.event === expected.event && event.step === expected.step,
    );
    expect(match).toMatchObject(expected);
  }

  it('prepares sign-in for the agent and keeps the callback alive until the user approves', async () => {
    harness.clearAuth();
    const base = `http://localhost:${server.port}`;
    const session = harness.runInteractive(
      `auth login --server ${base} --no-organization --non-interactive --no-browser --events`,
    );
    const action = await session.waitEvent('browser_required');
    expect(action).toMatchObject({ step: 'connect_account', actor: 'user' });
    const signIn = new URL(action.url as string);
    expect(signIn.origin).toBe(base);
    expect(harness.stateJsonFile.asJson().auth.connections).toHaveLength(0);
    const response = await fetch(`http://127.0.0.1:${signIn.searchParams.get('port')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'onboarding-test-token', name: 'approved-connection' }),
    });
    expect(response.status).toBe(200);
    const result = await session.waitFinish();
    expect(result.exitCode).toBe(0);
    expectEvent(result.stderr, {
      event: 'step_completed',
      step: 'connect_account',
      actor: 'agent',
    });
    expect(result.stdout + result.stderr).not.toContain('onboarding-test-token');
  }, 15000);

  it('reconnects an expired saved sign-in instead of reporting a successful cached login', async () => {
    acceptedLoginToken = 'fresh-approved-token';
    const base = `http://localhost:${server.port}`;
    const session = harness.runInteractive(
      `auth login --server ${base} --no-organization --non-interactive --no-browser --events`,
      { browserToken: acceptedLoginToken },
    );
    const result = await session.waitFinish();
    expect(result.exitCode).toBe(0);
    expectEvent(result.stderr, { event: 'browser_required', step: 'connect_account' });
    expect(result.stdout).not.toContain('Token already exists');
  }, 15000);

  it('does not prepare a browser action when the saved connection is still valid', async () => {
    const base = `http://localhost:${server.port}`;
    const result = await run(
      `auth login --server ${base} --no-organization --non-interactive --no-browser --events`,
    );
    expect(result.exitCode).toBe(0);
    expect(events(result.stderr).some((event) => event.event === 'browser_required')).toBe(false);
    expectEvent(result.stderr, { event: 'step_completed', step: 'connect_account' });
  });

  it('rejects an invalid callback in manual non-interactive mode without waiting forever', async () => {
    acceptedLoginToken = 'required-token';
    const base = `http://localhost:${server.port}`;
    const session = harness.runInteractive(
      `auth login --server ${base} --no-organization --non-interactive --no-browser --events --force`,
      { browserToken: 'invalid-test-token', extraEnv: { CI: 'false' } },
    );
    const result = await session.waitFinish();
    expect(result.exitCode).toBe(1);
    expectEvent(result.stderr, { event: 'step_failed', step: 'connect_account' });
    expect(result.stdout + result.stderr).not.toContain('invalid-test-token');
  }, 15000);

  it('prepares GitHub access before Cloud changes and resumes after user approval', async () => {
    installation = false;
    const session = harness.runInteractive(
      `org import --github ${OWNER} --no-browser --events --timeout 10 --format json`,
    );
    const action = await session.waitEvent('browser_required');
    expect(action).toMatchObject({ step: 'github_access', actor: 'user' });
    expect(new URL(action.url as string).searchParams.get('state')).toBe('sonarqube-cli');
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
    installation = true;
    const result = await session.waitFinish();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).organizationKey).toBe(OWNER);
    expectEvent(result.stderr, { event: 'step_completed', step: 'cloud_setup', actor: 'agent' });
  }, 15000);

  it('reports the failed Cloud step after GitHub access succeeds', async () => {
    bound = true;
    forbidEmptySubscriptionRead = true;
    const result = await run(`org import --github ${OWNER} --no-browser --events --format json`);
    expect(result.exitCode).toBe(1);
    expectEvent(result.stderr, { event: 'step_completed', step: 'github_access' });
    expectEvent(result.stderr, { event: 'step_failed', step: 'cloud_setup' });
    expect(events(result.stderr).some((event) => event.event === 'browser_required')).toBe(false);
  });

  it('keeps analysis progress separate from the completed-result JSON', async () => {
    const result = await run('project wait --project hackathon_repo --events --format json');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).analysisId).toBe('analysis-1');
    expectEvent(result.stderr, { event: 'step_started', step: 'analysis', actor: 'agent' });
    expectEvent(result.stderr, { event: 'step_completed', step: 'analysis' });
  });

  it('requires manual browser handoffs when requesting agent events', async () => {
    const result = await run(`org import --github ${OWNER} --events`);
    expect(result.exitCode).toBe(2);
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
    const login = await run(
      'auth login --server https://sonarcloud.io --no-organization --non-interactive --events',
    );
    expect(login.exitCode).toBe(2);
  });

  it.each(['javascript:alert(1)', 'file:///tmp/example', 'https://user:password@example.test/'])(
    'rejects unsafe browser-action URLs: %s',
    async (url) => {
      const result = await run(`browser open '${url}'`);
      expect(result.exitCode).toBe(2);
    },
  );

  it('imports and binds an organization, subscribes to Free, and selects it without asking for an org at login', async () => {
    const result = await run(`org import --github ${OWNER} --plan free --format json`);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).organizationKey).toBe(OWNER);
    const create = requests.find((r) => r.path === '/api/organizations/create');
    expect(new URLSearchParams(create?.body).get('installationId')).toBe('1234');
    const subscribe = requests.find(
      (r) => r.path === '/billing/subscriptions' && r.method === 'POST',
    );
    expect(JSON.parse(subscribe!.body)).toEqual({
      customerName: 'Hackathon',
      entityId: 'uuid-org',
      entityType: 'organization',
      priceId: 'free-price',
      email: 'tester@example.test',
    });
    const state = harness.stateJsonFile.asJson();
    expect(
      state.auth.connections.find(
        (connection: { id: string }) => connection.id === state.auth.activeConnectionId,
      )?.orgKey,
    ).toBe(OWNER);
    expect(result.stdout + result.stderr).not.toContain('onboarding-test-token');
  }, 15000);

  it('starts a cardless Team trial by default without selecting a paid price', async () => {
    const result = await run(`org import --github ${OWNER} --format json`);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.plan).toBe('Team');
    expect(output.trial).toBe(true);
    expect(Date.parse(output.trialPeriod.end as string)).toBeGreaterThan(Date.now());
    const post = requests.find((r) => r.path === '/billing/subscriptions' && r.method === 'POST');
    expect(JSON.parse(post!.body)).toEqual({
      customerName: 'Hackathon',
      entityId: 'uuid-org',
      entityType: 'organization',
      email: 'tester@example.test',
    });
    expect(requests.some((r) => r.path === '/billing/plans')).toBe(false);
    expect(result.stderr).toContain('trial ends');
  });

  it.each(['ACTIVE', 'UNKNOWN'])(
    'does not continue when payment method status is %s',
    async (status) => {
      paymentMethodStatus = status;
      const result = await run(`org import --github ${OWNER}`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('did not confirm a cardless trial');
      expect(
        requests.filter((r) => r.path === '/billing/subscriptions' && r.method === 'POST'),
      ).toHaveLength(1);
    },
  );

  it('does not accept a Team subscription without the trial flag', async () => {
    reportedTrial = false;
    const result = await run(`org import --github ${OWNER}`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('did not confirm an active Team trial');
  });

  it.each(['invalid-date', '2020-01-01T00:00:00Z'])(
    'rejects an invalid or expired trial expiry: %s',
    async (end) => {
      trialEnd = end;
      const result = await run(`org import --github ${OWNER}`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('did not confirm an active Team trial');
    },
  );

  it('reports rejected trials without trying a paid or Free fallback', async () => {
    rejectTrial = true;
    const result = await run(`org import --github ${OWNER}`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Trial already used');
    expect(
      requests.filter((r) => r.path === '/billing/subscriptions' && r.method === 'POST'),
    ).toHaveLength(1);
    expect(requests.some((r) => r.path === '/billing/plans')).toBe(false);
  });

  it('requires email before requesting a trial', async () => {
    userEmail = undefined;
    const result = await run(`org import --github ${OWNER}`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('account email is required');
    expect(requests.some((r) => r.path === '/billing/subscriptions' && r.method === 'POST')).toBe(
      false,
    );
  });

  it('identifies the failed discovery step and exposes the server explanation without creating an organization', async () => {
    discoveryError = 'Authentication method is not supported';
    const result = await run(`org import --github ${OWNER} --format json`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('GitHub installation discovery failed');
    expect(result.stderr).toContain(discoveryError);
    expect(result.stdout).not.toContain('organizationKey');
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('creates trial signup before reading subscriptions for a newly created organization', async () => {
    forbidEmptySubscriptionRead = true;
    const result = await run(`org import --github ${OWNER} --format json`);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).plan).toBe('Team');
    const billingRequests = requests.filter((request) => request.path === '/billing/subscriptions');
    expect(billingRequests[0].method).toBe('POST');
    expect(billingRequests[1].method).toBe('GET');
  });

  it('does not treat a forbidden existing-subscription lookup as permission to create one', async () => {
    bound = true;
    forbidEmptySubscriptionRead = true;
    const result = await run(`org import --github ${OWNER}`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Existing subscription lookup failed (GET /billing/subscriptions)',
    );
    expect(
      requests.some(
        (request) => request.path === '/billing/subscriptions' && request.method === 'POST',
      ),
    ).toBe(false);
  });

  it('reuses an existing binding and subscription without creating anything', async () => {
    bound = true;
    subscribed = true;
    const result = await run(`org import --github ${OWNER} --format json`);
    expect(result.exitCode).toBe(0);
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
    expect(JSON.parse(result.stdout).plan).toBe('free_v2');
  });

  it('binds an existing unbound organization and preserves its subscription', async () => {
    existingOrganization = true;
    subscribed = true;
    const result = await run(`org import --github ${OWNER} --format json`);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).organizationKey).toBe(OWNER);
    expect(JSON.parse(result.stdout).plan).toBe('free_v2');
    const binding = requests.find((r) => r.path === '/api/alm_integration/bind_organization');
    expect(Object.fromEntries(new URLSearchParams(binding!.body))).toEqual({
      organization: OWNER,
      installationId: '1234',
    });
    expect(requests.some((r) => r.path === '/api/organizations/create')).toBe(false);
    expect(requests.some((r) => r.path === '/billing/subscriptions' && r.method === 'POST')).toBe(
      false,
    );
  });

  it('does not replace a different binding on the existing organization', async () => {
    existingOrganization = true;
    otherBinding = true;
    const result = await run(`org import --github ${OWNER}`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('already bound to another DevOps account');
    expect(requests.some((r) => r.path === '/api/alm_integration/bind_organization')).toBe(false);
    expect(requests.some((r) => r.path === '/api/organizations/create')).toBe(false);
  });

  it('resumes after subscription failure without duplicating the organization', async () => {
    subscriptionFailures = 1;
    const first = await run(`org import --github ${OWNER}`);
    expect(first.exitCode).toBe(1);
    const second = await run(`org import --github ${OWNER}`);
    expect(second.exitCode).toBe(0);
    expect(requests.filter((r) => r.path === '/api/organizations/create')).toHaveLength(1);
  });

  it('prints the installation URL and detects the installed App while polling', async () => {
    installation = false;
    installAfterRequest = 3;
    const result = await run(
      `org import --github ${OWNER} --no-browser --timeout 10 --format json`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      'https://github.com/apps/sonarcloud/installations/new?state=sonarqube-cli',
    );
    expect(JSON.parse(result.stdout).organizationKey).toBe(OWNER);
  }, 15000);

  it('fails clearly when GitHub installation never completes', async () => {
    installation = false;
    const result = await run(`org import --github ${OWNER} --no-browser --timeout 1`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Timed out waiting for the GitHub App installation');
    expect(requests.some((r) => r.path === '/api/organizations/create')).toBe(false);
  });

  it('refuses to choose a Free price that actually costs money', async () => {
    planAmount = 10;
    const result = await run(`org import --github ${OWNER} --plan free`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('zero-cost Free plan');
    expect(requests.some((r) => r.path === '/billing/subscriptions' && r.method === 'POST')).toBe(
      false,
    );
  });

  it('rejects non-administrators before making mutations', async () => {
    bound = true;
    admin = false;
    const result = await run(`org import --github ${OWNER}`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('administrator permissions');
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('rejects a requested key that conflicts with an existing binding', async () => {
    bound = true;
    const result = await run(`org import --github ${OWNER} --key different`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('already bound');
  });

  it('logs in using an org-independent token and keeps it usable on the next invocation', async () => {
    harness.clearAuth();
    const base = `http://localhost:${server.port}`;
    const result = await harness.runWithStdin(
      `auth login --server ${base} --no-organization --with-token`,
      'onboarding-test-token\n',
    );
    expect(result.exitCode).toBe(0);
    expect(requests.some((r) => r.path === '/api/organizations/search')).toBe(false);
    harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));
    const imported = await run(`org import --github ${OWNER} --format json`);
    expect(imported.exitCode).toBe(0);
  }, 15000);

  it('completes browser login, organization signup, repository import, and analysis waiting in sequence', async () => {
    harness.clearAuth();
    const base = `http://localhost:${server.port}`;
    const login = harness.runInteractive(
      `auth login --server ${base} --no-organization --non-interactive`,
      {
        browserToken: 'onboarding-test-token',
        browserTokenName: 'hackathon-cli',
      },
    );
    const loggedIn = await login.waitFinish();
    expect(loggedIn.exitCode).toBe(0);
    expect(loggedIn.stdout).not.toContain('or paste token');
    expect(requests.some((r) => r.path === '/api/organizations/search')).toBe(false);
    harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));
    const org = await run(`org import --github ${OWNER} --format json`);
    expect(org.exitCode).toBe(0);
    harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));
    const imported = await run(`import --repo ${OWNER}/repo --non-interactive`);
    expect(imported.exitCode).toBe(0);
    const provision = requests.find((r) => r.path === '/api/alm_integration/provision_projects');
    expect(new URLSearchParams(provision?.body).get('installationKeys')).toBe(`${OWNER}/repo|42`);
    analysesReady = false;
    eligibilityStatus = 202;
    const analyzed = await run(`project wait --repo ${OWNER}/repo --format json --timeout 10`);
    expect(analyzed.exitCode).toBe(0);
    expect(JSON.parse(analyzed.stdout)).toMatchObject({
      projectKey: 'hackathon_repo',
      analysisId: 'analysis-1',
    });
  }, 15000);

  it('forces a fresh browser exchange even when a saved user token exists', async () => {
    const base = `http://localhost:${server.port}`;
    const login = harness.runInteractive(
      `auth login --server ${base} --no-organization --non-interactive --force`,
      {
        browserToken: 'fresh-github-test-token',
        browserTokenName: 'fresh-github-login',
      },
    );
    const result = await login.waitFinish();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Obtaining access token');
    expect(result.stdout).not.toContain('Token already exists');
    expect(result.stdout + result.stderr).not.toContain('fresh-github-test-token');
    const state = harness.stateJsonFile.asJson();
    expect(
      state.auth.connections.find(
        (connection: { id: string }) => connection.id === state.auth.activeConnectionId,
      )?.tokenName,
    ).toBe('fresh-github-login');
  }, 15000);

  it('rejects --org combined with --no-organization before authentication', async () => {
    const result = await run('auth login --no-organization --org existing');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('cannot be combined');
  });

  it('returns a real completed analysis and resolves its key from the repository binding', async () => {
    harness
      .state()
      .withActiveConnection(`http://localhost:${server.port}`, 'cloud', OWNER)
      .withKeychainToken(`http://localhost:${server.port}`, 'onboarding-test-token', OWNER);
    const result = await run(`project wait --repo ${OWNER}/repo --format json`);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      projectKey: 'hackathon_repo',
      analysisId: 'analysis-1',
    });
    expect(requests.some((r) => r.path === '/api/autoscan/eligibility')).toBe(false);
  });

  it('handles an empty 202 eligibility response and waits for completed analysis', async () => {
    analysesReady = false;
    eligibilityStatus = 202;
    const result = await run('project wait --project hackathon_repo --format json --timeout 10');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).analysisId).toBe('analysis-1');
    const check = requests.find((r) => r.path === '/api/autoscan/eligibility');
    expect(check?.query.get('autoEnable')).toBe('true');
    expect(
      requests.filter((r) => r.path === '/api/project_analyses/search').length,
    ).toBeGreaterThan(1);
  }, 15000);

  it('does not treat provisioning as analysis when automatic analysis is unsupported', async () => {
    analysesReady = false;
    eligibility = false;
    const result = await run('project wait --project hackathon_repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Configure CI analysis');
    expect(result.stdout).not.toContain('Analysis completed');
  });

  it('propagates an eligibility authorization error instead of polling until timeout', async () => {
    analysesReady = false;
    eligibilityStatus = 403;
    const result = await run('project wait --project hackathon_repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('403');
    expect(requests.filter((r) => r.path === '/api/autoscan/eligibility')).toHaveLength(1);
  });

  it('times out without claiming success, and remains resumable', async () => {
    analysesReady = false;
    const result = await run('project wait --project hackathon_repo --timeout 1');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('rerun this command to resume');
    analysesReady = true;
    const retry = await run('project wait --project hackathon_repo --format json');
    expect(retry.exitCode).toBe(0);
  });

  it('requires explicit project selection for monorepos', async () => {
    linkedProjects.push({ key: 'second_project', name: 'Second' });
    harness
      .state()
      .withActiveConnection(`http://localhost:${server.port}`, 'cloud', OWNER)
      .withKeychainToken(`http://localhost:${server.port}`, 'onboarding-test-token', OWNER);
    const result = await run(`project wait --repo ${OWNER}/repo`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Use --project for monorepos');
  });

  it('rejects invalid timeouts before onboarding mutations', async () => {
    const result = await run(`org import --github ${OWNER} --timeout 0`);
    expect(result.exitCode).toBe(2);
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });
});
