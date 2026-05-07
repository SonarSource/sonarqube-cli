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

// Integration tests for the `sonar remediate` command.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';
const TEST_PROJECT = 'my-project';

describe('sonar remediate', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    // Bypass the TTY guard for tests; specs verifying the guard itself
    // override SONARQUBE_CLI_MOCK_TTY back to empty via extraEnv.
    harness.withExtraEnv({ SONARQUBE_CLI_MOCK_TTY: '1' });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 and points at --issues when stdin is not a TTY and --issues is missing',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run(`remediate --project ${TEST_PROJECT}`, {
        extraEnv: { SONARQUBE_CLI_MOCK_TTY: '' },
      });

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('Non-interactive mode requires --issues <issueIds>');
      expect(output).toContain('sonar list issues --project <key>');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 and error when connected to an on-premise server',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
      // No org → on-premise connection
      harness.withAuth(server.baseUrl(), VALID_TOKEN);

      const result = await harness.run(`remediate --project ${TEST_PROJECT}`);

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('requires SonarQube Cloud');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 and prompts to authenticate when no active connection',
    async () => {
      const result = await harness.run(`remediate --project ${TEST_PROJECT}`);

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('sonar auth login');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 and shows not-available message when org is not eligible for AI remediation',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withProject(TEST_PROJECT, (p) => {
          p.withIssue({ ruleKey: 'java:S100', message: 'Fixable issue', fixableByAgent: true });
        })
        .withOrgEntitlement(false, false)
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run(`remediate --project ${TEST_PROJECT}`);

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('The Remediation Agent is not available for your organization');
      expect(output).toContain(TEST_ORG);
      expect(output).toContain('docs.sonarsource.com');
      expect(output).not.toContain('Which issues');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 and shows not-enabled message when delegate issues is disabled',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withProject(TEST_PROJECT, (p) => {
          p.withIssue({ ruleKey: 'java:S100', message: 'Fixable issue', fixableByAgent: true });
        })
        .withOrgEntitlement(true, false)
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run(`remediate --project ${TEST_PROJECT}`);

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('The Remediation Agent is not enabled for your organization');
      expect(output).toContain(TEST_ORG);
      expect(output).toContain('docs.sonarsource.com');
      expect(output).not.toContain('Which issues');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 and shows not-available message when the org lookup returns an empty array',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withProject(TEST_PROJECT, (p) => {
          p.withIssue({ ruleKey: 'java:S100', message: 'Fixable issue', fixableByAgent: true });
        })
        .withMissingOrg()
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run(`remediate --project ${TEST_PROJECT}`);

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('The Remediation Agent is not available for your organization');
      expect(output).toContain(TEST_ORG);
      expect(output).toContain('docs.sonarsource.com');
      expect(output).not.toContain('Which issues');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 and shows could-not-verify message when the entitlement service returns 5xx',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withProject(TEST_PROJECT, (p) => {
          p.withIssue({ ruleKey: 'java:S100', message: 'Fixable issue', fixableByAgent: true });
        })
        .withOrgsLookupError(503)
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run(`remediate --project ${TEST_PROJECT}`);

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('Could not verify Remediation Agent entitlement');
      expect(output).not.toContain('docs.sonarsource.com');
      expect(output).not.toContain('Which issues');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and reports zero eligible issues when none are fixable by agent',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withProject(TEST_PROJECT, (p) => {
          p.withIssue({ ruleKey: 'java:S100', message: 'Not fixable', fixableByAgent: false });
        })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run(`remediate --project ${TEST_PROJECT}`);

      expect(result.exitCode).toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain('No eligible issues found');
      expect(output).not.toContain('Which issues');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and reports no issues selected when user presses q to quit',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withProject(TEST_PROJECT, (p) => {
          p.withIssue({ ruleKey: 'java:S100', message: 'Fixable issue', fixableByAgent: true });
        })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run(`remediate --project ${TEST_PROJECT}`, {
        stdinChunks: ['q'],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('No issues selected');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and reports no issues selected when user submits empty selection',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withProject(TEST_PROJECT, (p) => {
          p.withIssue({ ruleKey: 'java:S100', message: 'Fixable issue', fixableByAgent: true });
        })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      // Enter immediately without selecting any issue
      const result = await harness.run(`remediate --project ${TEST_PROJECT}`, {
        stdinChunks: ['\r'],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('No issues selected');
    },
    { timeout: 15000 },
  );

  it(
    'submits a remediation job and reports success with activity URL',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withProject(TEST_PROJECT, (p) => {
          p.withIssue({ ruleKey: 'java:S100', message: 'Fixable issue', fixableByAgent: true });
        })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      // Space to select the first issue, then Enter to confirm
      const result = await harness.run(`remediate --project ${TEST_PROJECT}`, {
        stdinChunks: [' ', '\r'],
      });

      expect(result.exitCode).toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain('Submitted 1 issue for remediation');
      expect(output).toContain('agent_activity');
      expect(output).toContain(TEST_PROJECT);
    },
    { timeout: 15000 },
  );

  it(
    'sends the correct projectId (legacy component ID) and issue keys in the job request',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withProject(TEST_PROJECT, (p) => {
          p.withIssue({
            key: 'ISSUE-42',
            ruleKey: 'java:S100',
            message: 'Fixable issue',
            fixableByAgent: true,
          });
        })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      await harness.run(`remediate --project ${TEST_PROJECT}`, {
        stdinChunks: [' ', '\r'],
      });

      const agentJobCalls = server
        .getRecordedRequests()
        .filter(
          (r) => r.path === '/fix-suggestions/ai-agent-scheduled-jobs' && r.method === 'POST',
        );
      expect(agentJobCalls).toHaveLength(1);
      const body = JSON.parse(agentJobCalls[0].body ?? '{}') as {
        projectId: string;
        issueKeys: string[];
        triggerSource: string;
      };
      // projectId must be the legacy component ID returned by /api/navigation/component
      expect(body.projectId).toBe(`AY${TEST_PROJECT}legacy`);
      expect(body.issueKeys).toEqual(['ISSUE-42']);
      expect(body.triggerSource).toBe('CLI');
    },
    { timeout: 15000 },
  );

  it(
    'fetches eligible issues with fixableByAgent=true and correct status filter',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withProject(TEST_PROJECT, (p) => {
          p.withIssue({ ruleKey: 'java:S100', message: 'Fixable issue', fixableByAgent: true });
        })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      // Enter without selecting to avoid submitting a job
      await harness.run(`remediate --project ${TEST_PROJECT}`, { stdinChunks: ['\r'] });

      const issuesSearchCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/issues/search');
      expect(issuesSearchCalls).toHaveLength(1);
      const query = issuesSearchCalls[0].query;
      expect(query['fixableByAgent']).toBe('true');
      expect(query['issueStatuses']).toContain('OPEN');
      expect(query['issueStatuses']).toContain('CONFIRMED');
      // The CLI uses 'components' for on-premise and 'projects' for SonarCloud;
      // the fake server uses a 127.0.0.1 URL so isCloud is false → 'components' is sent
      const projectParamValue = query['components'] ?? query['projects'];
      expect(projectParamValue).toBe(TEST_PROJECT);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 and maps "no allowance" error to a plan upgrade message',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withProject(TEST_PROJECT, (p) => {
          p.withIssue({ ruleKey: 'java:S100', message: 'Fixable issue', fixableByAgent: true });
        })
        .withAgentJobError(403, 'Organization does not have allowance for AI agent jobs')
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run(`remediate --project ${TEST_PROJECT}`, {
        stdinChunks: [' ', '\r'],
      });

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('organization plan does not include the Remediation Agent');
      expect(output).toContain('docs.sonarsource.com');
    },
    { timeout: 15000 },
  );

  it.each([
    ['insufficient privileges', 403, 'Insufficient privileges'],
    ['app not installed', 400, 'Agent app is not installed for project'],
    ['unknown error', 500, 'Internal server error'],
  ])(
    'exits with code 1 and maps "%s" error to the not-enabled message',
    async (_label, statusCode, apiMessage) => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withProject(TEST_PROJECT, (p) => {
          p.withIssue({ ruleKey: 'java:S100', message: 'Fixable issue', fixableByAgent: true });
        })
        .withAgentJobError(statusCode, apiMessage)
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run(`remediate --project ${TEST_PROJECT}`, {
        stdinChunks: [' ', '\r'],
      });

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('The Remediation Agent is not enabled for your organization');
      expect(output).toContain('docs.sonarsource.com');
    },
    { timeout: 15000 },
  );

  it(
    'auto-discovers the project key from sonar-project.properties when --project is omitted',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withProject(TEST_PROJECT, (p) => {
          p.withIssue({ ruleKey: 'java:S100', message: 'Fixable issue', fixableByAgent: true });
        })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);
      harness.cwd.writeFile('sonar-project.properties', `sonar.projectKey=${TEST_PROJECT}\n`);

      const result = await harness.run('remediate', { stdinChunks: ['\r'] });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(TEST_PROJECT);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 and reports missing project key when --project is omitted and no config is found',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run('remediate');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Could not determine project key');
    },
    { timeout: 15000 },
  );

  it(
    'submits a job with all selected issue keys and reports plural "issues" count',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withProject(TEST_PROJECT, (p) => {
          p.withIssue({
            key: 'ISSUE-1',
            ruleKey: 'java:S100',
            message: 'First issue',
            fixableByAgent: true,
          });
          p.withIssue({
            key: 'ISSUE-2',
            ruleKey: 'java:S200',
            message: 'Second issue',
            fixableByAgent: true,
          });
        })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      // Space selects item at cursor 0, Down moves cursor, Space selects cursor 1, Enter confirms
      const result = await harness.run(`remediate --project ${TEST_PROJECT}`, {
        stdinChunks: [' ', '\x1b[B', ' ', '\r'],
      });

      expect(result.exitCode).toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain('Submitted 2 issues for remediation');

      const agentJobCalls = server
        .getRecordedRequests()
        .filter(
          (r) => r.path === '/fix-suggestions/ai-agent-scheduled-jobs' && r.method === 'POST',
        );
      expect(agentJobCalls).toHaveLength(1);
      const body = JSON.parse(agentJobCalls[0].body ?? '{}') as { issueKeys: string[] };
      expect(body.issueKeys).toHaveLength(2);
      expect(body.issueKeys).toContain('ISSUE-1');
      expect(body.issueKeys).toContain('ISSUE-2');
    },
    { timeout: 15000 },
  );

  it(
    'caps the eligible-issues list at MAX_PAGE_SIZE (500) when the project has more',
    async () => {
      // The remediate command intentionally fetches a single page of up to 500
      // eligible issues. This documents that cap: with 501 fixable issues the
      // user sees exactly 500, requested with ps=500&p=1.
      const totalIssues = 501;
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withProject(TEST_PROJECT, (p) => {
          for (let i = 1; i <= totalIssues; i++) {
            p.withIssue({
              key: `ISSUE-${i}`,
              ruleKey: 'java:S100',
              message: `Fixable issue ${i}`,
              fixableByAgent: true,
            });
          }
        })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run(`remediate --project ${TEST_PROJECT}`, {
        stdinChunks: ['q'],
      });

      expect(result.exitCode).toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain('500 eligible issues found');
      expect(output).not.toContain('501 eligible issues found');

      const issuesSearchCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/issues/search');
      expect(issuesSearchCalls).toHaveLength(1);
      expect(issuesSearchCalls[0].query['ps']).toBe('500');
      expect(issuesSearchCalls[0].query['p']).toBe('1');
    },
    { timeout: 30000 },
  );

  it(
    'sorts issues by severity so BLOCKER appears first in the selector',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withProject(TEST_PROJECT, (p) => {
          p.withIssue({
            key: 'INFO-1',
            ruleKey: 'java:S100',
            message: 'Info issue',
            severity: 'INFO',
            fixableByAgent: true,
          });
          p.withIssue({
            key: 'BLOCKER-1',
            ruleKey: 'java:S200',
            message: 'Blocker issue',
            severity: 'BLOCKER',
            fixableByAgent: true,
          });
        })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      // Space selects the first item in the list - must be the BLOCKER after sorting
      await harness.run(`remediate --project ${TEST_PROJECT}`, {
        stdinChunks: [' ', '\r'],
      });

      const agentJobCalls = server
        .getRecordedRequests()
        .filter(
          (r) => r.path === '/fix-suggestions/ai-agent-scheduled-jobs' && r.method === 'POST',
        );
      expect(agentJobCalls).toHaveLength(1);
      const body = JSON.parse(agentJobCalls[0].body ?? '{}') as { issueKeys: string[] };
      expect(body.issueKeys).toEqual(['BLOCKER-1']);
    },
    { timeout: 15000 },
  );

  describe('--issues (non-interactive mode)', () => {
    it(
      'submits the supplied keys without consulting /api/issues/search in TTY mode',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken(VALID_TOKEN)
          .withProject(TEST_PROJECT)
          .start();
        harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

        const result = await harness.run(`remediate --project ${TEST_PROJECT} --issues k1,k2,k3`);

        expect(result.exitCode).toBe(0);
        const output = result.stdout + result.stderr;
        expect(output).toContain('Submitted 3 issues for remediation');
        expect(output).toContain('agent_activity');
        expect(output).toContain(TEST_PROJECT);

        const issuesSearchCalls = server
          .getRecordedRequests()
          .filter((r) => r.path === '/api/issues/search');
        expect(issuesSearchCalls).toHaveLength(0);

        const agentJobCalls = server
          .getRecordedRequests()
          .filter(
            (r) => r.path === '/fix-suggestions/ai-agent-scheduled-jobs' && r.method === 'POST',
          );
        expect(agentJobCalls).toHaveLength(1);
        const body = JSON.parse(agentJobCalls[0].body ?? '{}') as {
          projectId: string;
          issueKeys: string[];
          triggerSource: string;
        };
        expect(body.projectId).toBe(`AY${TEST_PROJECT}legacy`);
        expect(body.issueKeys).toEqual(['k1', 'k2', 'k3']);
        expect(body.triggerSource).toBe('CLI');
      },
      { timeout: 15000 },
    );

    it(
      'submits the supplied keys when stdin is not a TTY',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken(VALID_TOKEN)
          .withProject(TEST_PROJECT)
          .start();
        harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

        const result = await harness.run(`remediate --project ${TEST_PROJECT} --issues k1,k2`, {
          extraEnv: { SONARQUBE_CLI_MOCK_TTY: '' },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toContain('Submitted 2 issues for remediation');

        const agentJobCalls = server
          .getRecordedRequests()
          .filter(
            (r) => r.path === '/fix-suggestions/ai-agent-scheduled-jobs' && r.method === 'POST',
          );
        expect(agentJobCalls).toHaveLength(1);
        const body = JSON.parse(agentJobCalls[0].body ?? '{}') as { issueKeys: string[] };
        expect(body.issueKeys).toEqual(['k1', 'k2']);
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 1 when more than 20 issue keys are supplied',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken(VALID_TOKEN)
          .withProject(TEST_PROJECT)
          .start();
        harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

        const tooMany = Array.from({ length: 21 }, (_, i) => `k${i + 1}`).join(',');
        const result = await harness.run(`remediate --project ${TEST_PROJECT} --issues ${tooMany}`);

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('--issues accepts at most 20 issue keys');
        expect(output).toContain('got 21');

        const agentJobCalls = server
          .getRecordedRequests()
          .filter(
            (r) => r.path === '/fix-suggestions/ai-agent-scheduled-jobs' && r.method === 'POST',
          );
        expect(agentJobCalls).toHaveLength(0);
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 1 when --issues contains empty entries',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken(VALID_TOKEN)
          .withProject(TEST_PROJECT)
          .start();
        harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

        const result = await harness.run(`remediate --project ${TEST_PROJECT} --issues "k1,,k2"`);

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('Empty entries are not allowed');

        const agentJobCalls = server
          .getRecordedRequests()
          .filter(
            (r) => r.path === '/fix-suggestions/ai-agent-scheduled-jobs' && r.method === 'POST',
          );
        expect(agentJobCalls).toHaveLength(0);
      },
      { timeout: 15000 },
    );

    it(
      'silently deduplicates repeated issue keys before submitting',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken(VALID_TOKEN)
          .withProject(TEST_PROJECT)
          .start();
        harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

        const result = await harness.run(`remediate --project ${TEST_PROJECT} --issues k1,k1,k2`);

        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toContain('Submitted 2 issues for remediation');

        const agentJobCalls = server
          .getRecordedRequests()
          .filter(
            (r) => r.path === '/fix-suggestions/ai-agent-scheduled-jobs' && r.method === 'POST',
          );
        expect(agentJobCalls).toHaveLength(1);
        const body = JSON.parse(agentJobCalls[0].body ?? '{}') as { issueKeys: string[] };
        expect(body.issueKeys).toEqual(['k1', 'k2']);
      },
      { timeout: 15000 },
    );

    it(
      'trims whitespace around each issue key',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken(VALID_TOKEN)
          .withProject(TEST_PROJECT)
          .start();
        harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

        const result = await harness.run(
          `remediate --project ${TEST_PROJECT} --issues "k1, k2 , k3"`,
        );

        expect(result.exitCode).toBe(0);

        const agentJobCalls = server
          .getRecordedRequests()
          .filter(
            (r) => r.path === '/fix-suggestions/ai-agent-scheduled-jobs' && r.method === 'POST',
          );
        expect(agentJobCalls).toHaveLength(1);
        const body = JSON.parse(agentJobCalls[0].body ?? '{}') as { issueKeys: string[] };
        expect(body.issueKeys).toEqual(['k1', 'k2', 'k3']);
      },
      { timeout: 15000 },
    );

    it(
      'short-circuits on entitlement failure before submitting any keys',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken(VALID_TOKEN)
          .withProject(TEST_PROJECT)
          .withOrgEntitlement(true, false)
          .start();
        harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

        const result = await harness.run(`remediate --project ${TEST_PROJECT} --issues k1`);

        expect(result.exitCode).toBe(1);
        expect(result.stdout + result.stderr).toContain(
          'The Remediation Agent is not enabled for your organization',
        );

        const agentJobCalls = server
          .getRecordedRequests()
          .filter(
            (r) => r.path === '/fix-suggestions/ai-agent-scheduled-jobs' && r.method === 'POST',
          );
        expect(agentJobCalls).toHaveLength(0);
      },
      { timeout: 15000 },
    );

    it(
      'still trips the cloud-only check when --issues is supplied',
      async () => {
        const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
        // No org → on-premise connection
        harness.withAuth(server.baseUrl(), VALID_TOKEN);

        const result = await harness.run(`remediate --project ${TEST_PROJECT} --issues k1`);

        expect(result.exitCode).toBe(1);
        expect(result.stdout + result.stderr).toContain('requires SonarQube Cloud');
      },
      { timeout: 15000 },
    );

    it(
      'fails with the cap error before the cloud-only check when --issues is malformed',
      async () => {
        const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
        // No org → on-premise connection. Format validation runs ahead of the
        // cloud check, so the user sees the actionable input error first.
        harness.withAuth(server.baseUrl(), VALID_TOKEN);

        const tooMany = Array.from({ length: 21 }, (_, i) => `k${i + 1}`).join(',');
        const result = await harness.run(`remediate --project ${TEST_PROJECT} --issues ${tooMany}`);

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('--issues accepts at most 20 issue keys');
        expect(output).not.toContain('requires SonarQube Cloud');
      },
      { timeout: 15000 },
    );

    it(
      'surfaces the "no allowance" server error via mapErrorMessage',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken(VALID_TOKEN)
          .withProject(TEST_PROJECT)
          .withAgentJobError(403, 'Organization does not have allowance for AI agent jobs')
          .start();
        harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

        const result = await harness.run(`remediate --project ${TEST_PROJECT} --issues k1`);

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('organization plan does not include the Remediation Agent');
        expect(output).toContain('docs.sonarsource.com');
      },
      { timeout: 15000 },
    );

    it(
      'accepts exactly 20 issue keys at the cap boundary',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken(VALID_TOKEN)
          .withProject(TEST_PROJECT)
          .start();
        harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

        const exactlyAtCap = Array.from({ length: 20 }, (_, i) => `k${i + 1}`).join(',');
        const result = await harness.run(
          `remediate --project ${TEST_PROJECT} --issues ${exactlyAtCap}`,
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toContain('Submitted 20 issues for remediation');

        const agentJobCalls = server
          .getRecordedRequests()
          .filter(
            (r) => r.path === '/fix-suggestions/ai-agent-scheduled-jobs' && r.method === 'POST',
          );
        expect(agentJobCalls).toHaveLength(1);
        const body = JSON.parse(agentJobCalls[0].body ?? '{}') as { issueKeys: string[] };
        expect(body.issueKeys).toHaveLength(20);
      },
      { timeout: 15000 },
    );

    it(
      'rejects a degenerate --issues value with the empty-entries error in non-TTY mode',
      async () => {
        // Regression guard: in non-TTY, a user who passes --issues with an empty
        // value used to hit the misleading "Non-interactive mode requires --issues"
        // guard. With validation now upfront, parseIssueKeys produces the accurate
        // "Empty entries are not allowed" message instead.
        const server = await harness
          .newFakeServer()
          .withAuthToken(VALID_TOKEN)
          .withProject(TEST_PROJECT)
          .start();
        harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

        const result = await harness.run(`remediate --project ${TEST_PROJECT} --issues ,`, {
          extraEnv: { SONARQUBE_CLI_MOCK_TTY: '' },
        });

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('Empty entries are not allowed');
        expect(output).not.toContain('Non-interactive mode requires');

        const agentJobCalls = server
          .getRecordedRequests()
          .filter(
            (r) => r.path === '/fix-suggestions/ai-agent-scheduled-jobs' && r.method === 'POST',
          );
        expect(agentJobCalls).toHaveLength(0);
      },
      { timeout: 15000 },
    );

    it(
      'submits using --issues with a project key auto-discovered from sonar-project.properties',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken(VALID_TOKEN)
          .withProject(TEST_PROJECT)
          .start();
        harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);
        harness.cwd.writeFile('sonar-project.properties', `sonar.projectKey=${TEST_PROJECT}\n`);

        const result = await harness.run('remediate --issues k1,k2');

        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toContain('Submitted 2 issues for remediation');

        const agentJobCalls = server
          .getRecordedRequests()
          .filter(
            (r) => r.path === '/fix-suggestions/ai-agent-scheduled-jobs' && r.method === 'POST',
          );
        expect(agentJobCalls).toHaveLength(1);
        const body = JSON.parse(agentJobCalls[0].body ?? '{}') as {
          projectId: string;
          issueKeys: string[];
        };
        expect(body.projectId).toBe(`AY${TEST_PROJECT}legacy`);
        expect(body.issueKeys).toEqual(['k1', 'k2']);
      },
      { timeout: 15000 },
    );
  });
});
