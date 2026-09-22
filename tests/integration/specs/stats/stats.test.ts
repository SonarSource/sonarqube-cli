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

import { backdateStatsEvents } from '../../../_common/stats-helpers';
import { TestHarness } from '../../harness';
import { initGitRepo, stageFile } from '../hook/git-test-helpers';

const DAY_MS = 86_400_000;

// Hardcoded test token — intentional fixture for secret detection, not a real credential
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
const VALID_TOKEN = 'fake-token';
const FAKE_SERVER = 'http://localhost:19999';
const EXIT_CODE_SECRETS_FOUND = 51;

describe('sonar stats', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.withExtraEnv({ [ALPHA_ENV_VAR]: 'true' });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'shows the day-0 empty state when nothing has been recorded, without requiring auth',
    async () => {
      const result = await harness.run('stats');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('nothing recorded yet');
      expect(result.stdout).toContain('sonar integrate');
    },
    { timeout: 15000 },
  );

  it(
    '--json on an empty ledger reports zero totals and no entitlement lookup',
    async () => {
      const result = await harness.run('stats --json');

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout) as {
        totalRuns: number;
        totalFindings: number;
        entitlement: unknown;
      };
      expect(json.totalRuns).toBe(0);
      expect(json.totalFindings).toBe(0);
      expect(json.entitlement).toBeNull();
    },
    { timeout: 15000 },
  );

  it(
    'reports a manual analyze secrets run in the default 30d window and the all-time column',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      harness.cwd.writeFile('secrets.js', `const token = "${GITHUB_TEST_TOKEN}";`);

      const scan = await harness.run('analyze secrets secrets.js');
      expect(scan.exitCode).toBe(EXIT_CODE_SECRETS_FOUND);

      const result = await harness.run('stats');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Analyses run');
      expect(result.stdout).toContain('secrets');
      expect(result.stdout).toContain('last 30 days');
      expect(result.stdout).toContain('all time');
      expect(result.stdout).toMatch(/Analyses run\s+1\s+\S+\s+1/);
    },
    { timeout: 30000 },
  );

  it(
    '--json reflects the recorded run and matches the all-time totals for a fresh ledger',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      harness.cwd.writeFile('secrets.js', `const token = "${GITHUB_TEST_TOKEN}";`);

      const scan = await harness.run('analyze secrets secrets.js');
      expect(scan.exitCode).toBe(EXIT_CODE_SECRETS_FOUND);

      const result = await harness.run('stats --json');

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout) as {
        totalRuns: number;
        allTime: { totalRuns: number; secretsBlockedTotal: number };
        analyzers: Array<{ analyzer: string; runs: number; findings: number }>;
      };
      expect(json.totalRuns).toBe(1);
      expect(json.allTime.totalRuns).toBe(1);
      expect(json.analyzers).toEqual([{ analyzer: 'sonar-secrets', runs: 1, findings: 1 }]);
    },
    { timeout: 30000 },
  );

  it(
    '--since all runs without error and keeps the all-time headline in sync with the window',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      harness.cwd.writeFile('secrets.js', `const token = "${GITHUB_TEST_TOKEN}";`);

      const scan = await harness.run('analyze secrets secrets.js');
      expect(scan.exitCode).toBe(EXIT_CODE_SECRETS_FOUND);

      const result = await harness.run('stats --since all --json');

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout) as {
        totalRuns: number;
        allTime: { totalRuns: number };
      };
      expect(json.totalRuns).toBe(1);
      expect(json.allTime.totalRuns).toBe(1);
    },
    { timeout: 30000 },
  );

  it(
    'does not show the empty state when only the 30d window is empty but all-time history exists',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      harness.cwd.writeFile('secrets.js', `const token = "${GITHUB_TEST_TOKEN}";`);

      const scan = await harness.run('analyze secrets secrets.js');
      expect(scan.exitCode).toBe(EXIT_CODE_SECRETS_FOUND);
      backdateStatsEvents(harness.sonarUserHome.path, Date.now() - 31 * DAY_MS);

      const textResult = await harness.run('stats');
      expect(textResult.exitCode).toBe(0);
      expect(textResult.stdout).not.toContain('nothing recorded yet');

      const jsonResult = await harness.run('stats --json');
      expect(jsonResult.exitCode).toBe(0);
      const json = JSON.parse(jsonResult.stdout) as {
        totalRuns: number;
        allTime: { totalRuns: number };
        entitlement: unknown;
      };
      expect(json.totalRuns).toBe(0);
      expect(json.allTime.totalRuns).toBe(1);
      expect(json.entitlement).not.toBeNull();
    },
    { timeout: 30000 },
  );

  it(
    'renders the --since all text card with bucketed sparklines once history spans more than 30 days',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      harness.cwd.writeFile('secrets.js', `const token = "${GITHUB_TEST_TOKEN}";`);

      const oldScan = await harness.run('analyze secrets secrets.js');
      expect(oldScan.exitCode).toBe(EXIT_CODE_SECRETS_FOUND);
      backdateStatsEvents(harness.sonarUserHome.path, Date.now() - 35 * DAY_MS);

      const recentScan = await harness.run('analyze secrets secrets.js');
      expect(recentScan.exitCode).toBe(EXIT_CODE_SECRETS_FOUND);

      const result = await harness.run('stats --since all');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('sonar stats · since');
      expect(result.stdout).toContain('one column per 2 days');
    },
    { timeout: 30000 },
  );

  it(
    'shows the dependency-risks entitlement placeholder when SCA is disabled for the org',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withScaEnabled(false)
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN);
      harness.cwd.writeFile('secrets.js', `const token = "${GITHUB_TEST_TOKEN}";`);

      const scan = await harness.run('analyze secrets secrets.js');
      expect(scan.exitCode).toBe(EXIT_CODE_SECRETS_FOUND);

      const result = await harness.run('stats');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('dependency risks');
      expect(result.stdout).toContain('not enabled for this organization');

      const jsonResult = await harness.run('stats --json');
      expect(jsonResult.exitCode).toBe(0);
      const json = JSON.parse(jsonResult.stdout) as { entitlement: { scaNotEnabled: boolean } };
      expect(json.entitlement.scaNotEnabled).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'renders the Secrets blocked breakdown by stop point when a hook blocks a commit',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      initGitRepo(harness.cwd.path);
      stageFile(harness.cwd.path, 'secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);

      const hookResult = await harness.run('hook git-pre-commit');
      expect(hookResult.exitCode).toBe(1);

      const result = await harness.run('stats');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Secrets blocked');
      expect(result.stdout).toContain('at commit');
      expect(result.stdout).toContain('secrets in staged files');
      expect(result.stdout).toMatch(/\d+ .+ token/i);
    },
    { timeout: 30000 },
  );

  it(
    'rejects an invalid --since value',
    async () => {
      const result = await harness.run('stats --since 90d');

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Allowed choices are 7d, 14d, 30d, all');
    },
    { timeout: 15000 },
  );
});
