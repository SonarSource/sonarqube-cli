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

// Integration tests for `analyze agentic` and `verify` commands.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { VORTEX_FEATURE_ID } from '@/commands/integrate/_common/vortex.ts';
import type { StoredAnalysisCompletedEvent } from '@/core/state/state.ts';
import { TELEMETRY_FLUSH_MODE_ENV } from '@/core/telemetry';
import { SECRETS_CALLER_COMMANDS } from '@/core/telemetry/secrets-analysis-telemetry.ts';
import {
  SQAA_ANALYZE_AGENTIC_CALLER_COMMAND,
  SQAA_ANALYZE_CALLER_COMMAND,
} from '@/core/telemetry/sqaa-analysis-telemetry.ts';

import {
  expectAgentPromptHint,
  expectNoAgentPromptHint,
} from '../../../_common/agent-hint-assertions.js';
import { readAnalysisEvents, readCommandEvents } from '../../../_common/telemetry-helpers';
import { TestHarness } from '../../harness';
import { commitFile, git, initGitRepo, stageFile } from '../hook/git-test-helpers';
import {
  allSqaaRequestsUseDeep,
  parseSqaaRequestBody,
  sqaaRequestFileCount,
  sqaaRequestFirstFilePath,
  totalSqaaFilesSent,
} from './sqaa-request-helpers';

const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';
const TEST_PROJECT = 'my-project';
// sonar-ignore-next-line
const GITHUB_TEST_TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234';
const EXIT_CODE_SECRETS_FOUND = 51;
const HTTP_TOO_MANY_REQUESTS = 429;

describe('analyze (no subcommand)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    initGitRepo(harness.cwd.path);
    commitFile(harness.cwd.path, '.gitignore', '.claude/\n');
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 and prompts to authenticate when no active connection',
    async () => {
      const result = await harness.run('analyze');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('❌ Not authenticated.');
      expect(output).toContain("  → Run 'sonar auth login' to authenticate.");
    },
    { timeout: 15000 },
  );

  it(
    'runs secrets scan then agentic analysis on the change set',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withSecretsBinaryInstalled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('new.ts', 'const x = 1;');

      const result = await harness.run('analyze', {
        extraEnv: { SONAR_SECRETS_ALLOW_UNSECURE_HTTP: 'true' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('No issues found');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'outputs combined JSON report with secrets and agentic results',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withSecretsBinaryInstalled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('new.ts', 'const x = 1;');

      const result = await harness.run('analyze --format json', {
        extraEnv: { SONAR_SECRETS_ALLOW_UNSECURE_HTTP: 'true' },
      });

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout) as {
        secrets: { issues: unknown[]; summary: { totalIssues: number } };
        agentic: { summary: { totalIssues: number } } | null;
      };
      expect(report.secrets.issues).toHaveLength(0);
      expect(report.secrets.summary.totalIssues).toBe(0);
      expect(report.agentic).not.toBeNull();
      expect(report.agentic?.summary.totalIssues).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'outputs combined JSON report with agentic null when secrets finds a secret',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withSecretsBinaryInstalled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('leaked.ts', `const token = "${GITHUB_TEST_TOKEN}";`);

      const result = await harness.run('analyze --format json', {
        extraEnv: { SONAR_SECRETS_ALLOW_UNSECURE_HTTP: 'true' },
      });

      expect(result.exitCode).toBe(EXIT_CODE_SECRETS_FOUND);
      const report = JSON.parse(result.stdout) as {
        secrets: { issues: unknown[]; summary: { totalIssues: number } };
        agentic: null;
      };
      expect(report.secrets.summary.totalIssues).toBeGreaterThan(0);
      expect(report.agentic).toBeNull();
    },
    { timeout: 15000 },
  );

  it(
    'outputs combined JSON report for a single file in JSON mode (--file --format json)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withSecretsBinaryInstalled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('target.ts', 'const x = 1;');

      const result = await harness.run('analyze --file target.ts --format json', {
        extraEnv: { SONAR_SECRETS_ALLOW_UNSECURE_HTTP: 'true' },
      });

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout) as {
        secrets: { issues: unknown[]; summary: { totalIssues: number } };
        agentic: { summary: { totalIssues: number } } | null;
      };
      expect(report.secrets.issues).toHaveLength(0);
      expect(report.secrets.summary.totalIssues).toBe(0);
      expect(report.agentic).not.toBeNull();
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 51 and skips agentic when secrets finds a secret (text mode)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withSecretsBinaryInstalled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('leaked.ts', `const token = "${GITHUB_TEST_TOKEN}";`);

      const result = await harness.run('analyze', {
        extraEnv: { SONAR_SECRETS_ALLOW_UNSECURE_HTTP: 'true' },
      });

      expect(result.exitCode).toBe(EXIT_CODE_SECRETS_FOUND);
      // Fail-fast: agentic analysis must not be called when secrets are found.
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'runs secrets and agentic on a single file in text mode (--file)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withSecretsBinaryInstalled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('target.ts', 'const x = 1;');

      const result = await harness.run('analyze --file target.ts', {
        extraEnv: { SONAR_SECRETS_ALLOW_UNSECURE_HTTP: 'true' },
      });

      expect(result.exitCode).toBe(0);
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'does not print help when --file is used without a configured project',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withSecretsBinaryInstalled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      harness.cwd.writeFile('target.ts', 'const x = 1;');

      const result = await harness.run('analyze --file target.ts', {
        extraEnv: { SONAR_SECRETS_ALLOW_UNSECURE_HTTP: 'true' },
      });

      const output = result.stdout + result.stderr;
      expect(result.exitCode).toBe(0);
      expect(output).toContain('No issues found');
      expect(output).toContain('Vortex agentic analysis skipped: no project configured');
      expect(output).not.toContain('Usage: sonar analyze');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'uses an explicit --project for the bare analyze command in change-set mode',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withSecretsBinaryInstalled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('new.ts', 'const x = 1;');

      const result = await harness.run('analyze --project explicit-project', {
        extraEnv: { SONAR_SECRETS_ALLOW_UNSECURE_HTTP: 'true' },
      });

      expect(result.exitCode).toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).not.toContain('no project configured');
      expect(output).toContain('No issues found');

      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
      const request = parseSqaaRequestBody(sqaaCalls[0].body);
      expect(sqaaRequestFirstFilePath(sqaaCalls[0].body)).toBe('new.ts');
      expect(request.projectKey).toBe('explicit-project');
      expect(request.files).toHaveLength(1);
      expect(request.analysisDepth).toBe('DEEP');
    },
    { timeout: 15000 },
  );

  it(
    'uses an explicit --project for the bare analyze command in JSON mode',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withSecretsBinaryInstalled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('new.ts', 'const x = 1;');

      const result = await harness.run('analyze --project explicit-project --format json', {
        extraEnv: { SONAR_SECRETS_ALLOW_UNSECURE_HTTP: 'true' },
      });

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout) as {
        agentic: { summary: { totalIssues: number } } | null;
        secrets: { issues: unknown[]; summary: { totalIssues: number } };
      };
      expect(report.secrets.issues).toHaveLength(0);
      expect(report.agentic).not.toBeNull();
      expect(report.agentic?.summary.totalIssues).toBe(0);

      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
      const request = JSON.parse(sqaaCalls[0].body ?? '{}') as { projectKey?: string };
      expect(request.projectKey).toBe('explicit-project');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and reports no files when change set is empty (text mode)',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();

      harness
        .state()
        .withSecretsBinaryInstalled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      const result = await harness.run('analyze', {
        extraEnv: { SONAR_SECRETS_ALLOW_UNSECURE_HTTP: 'true' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('no files in the change set');
    },
    { timeout: 15000 },
  );

  it(
    'outputs combined JSON report with empty results when change set is empty',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();

      harness
        .state()
        .withSecretsBinaryInstalled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      const result = await harness.run('analyze --format json', {
        extraEnv: { SONAR_SECRETS_ALLOW_UNSECURE_HTTP: 'true' },
      });

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout) as {
        secrets: { issues: unknown[]; summary: { totalIssues: number } };
        agentic: { files: unknown[]; summary: { totalIssues: number } } | null;
      };
      expect(report.secrets.issues).toHaveLength(0);
      expect(report.agentic).not.toBeNull();
      expect(report.agentic?.files).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'JSON report includes ignored files when all change-set files are excluded (--format json)',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();

      harness
        .state()
        .withSecretsBinaryInstalled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      // Binary file only — NUL byte triggers binary detection, excluded from change set.
      writeFileSync(join(harness.cwd.path, 'image.bin'), Buffer.alloc(1));

      const result = await harness.run('analyze --format json', {
        extraEnv: { SONAR_SECRETS_ALLOW_UNSECURE_HTTP: 'true' },
      });

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout) as {
        secrets: { issues: unknown[] };
        agentic: { ignored: { path: string; reason: string }[] } | null;
      };
      expect(report.secrets.issues).toHaveLength(0);
      expect(report.agentic).not.toBeNull();
      expect(report.agentic?.ignored.length).toBeGreaterThan(0);
      expect(report.agentic?.ignored[0].reason).toBe('binary');
    },
    { timeout: 15000 },
  );

  it(
    'outputs combined JSON report with secrets null when secrets binary is not installed',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('new.ts', 'const x = 1;');

      const result = await harness.run('analyze --format json');

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout) as {
        secrets: null;
        agentic: { summary: { totalIssues: number } } | null;
      };
      expect(report.secrets).toBeNull();
      expect(report.agentic).not.toBeNull();
      expect(report.agentic?.summary.totalIssues).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'outputs combined JSON report with agentic null for on-premise connection',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();

      harness.state().withSecretsBinaryInstalled().withAuth(server.baseUrl(), VALID_TOKEN);

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('new.ts', 'const x = 1;');

      const result = await harness.run('analyze --format json', {
        extraEnv: { SONAR_SECRETS_ALLOW_UNSECURE_HTTP: 'true' },
      });

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout) as {
        secrets: { issues: unknown[]; summary: { totalIssues: number } };
        agentic: null;
      };
      expect(report.secrets.issues).toHaveLength(0);
      expect(report.agentic).toBeNull();
    },
    { timeout: 15000 },
  );
});

describe('analyze agentic', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 2 when file does not exist',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run('analyze agentic --file nonexistent.ts');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain('File not found');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 and prompts to authenticate when no active connection',
    async () => {
      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze agentic --file src/index.ts');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('❌ Not authenticated.');
      expect(output).toContain("  → Run 'sonar auth login' to authenticate.");
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0, warns, and skips SQAA for on-premise server',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN);

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze agentic --file src/index.ts');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'Vortex agentic analysis skipped: a SonarQube Cloud connection is required. Run: sonar auth login (ensure you connect to SonarQube Cloud)',
      );
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when no extension registered for this project',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      // Connection exists but no withSqaaFeature() → no projectKey in state → error
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze agentic --file src/index.ts');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        'Vortex agentic analysis requires a project, but none is configured for this directory.',
      );
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'calls SQAA API when --project and --branch are provided (bypasses extension registry)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      // Cloud auth only — no extension registered; --project + --branch bypass registry lookup
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run(
        `analyze agentic --file src/index.ts --project ${TEST_PROJECT} --branch main`,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('No issues found');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 and names the file in the remediation hint when the --file path cannot be read as a file',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      harness.cwd.writeFile('src/.keep', '');

      const result = await harness.run(`analyze agentic --file src --project ${TEST_PROJECT}`);

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('Failed to read file');
      expect(output).toContain(
        "  → Check that 'src' exists and is readable as a file, then retry.",
      );
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'calls SQAA API and reports No issues found for clean file',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze agentic --file src/index.ts');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('No issues found');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
      expect(result.stdout + result.stderr).toContain('STANDARD analysis');
      expect(parseSqaaRequestBody(sqaaCalls[0].body).analysisDepth).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it(
    'resolves the project key from a recorded Vortex feature',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl(), {
          featureId: VORTEX_FEATURE_ID,
        });

      harness.cwd.writeFile('index.ts', 'const x = 1;');
      const result = await harness.run('analyze agentic --file index.ts');

      expect(result.exitCode).toBe(0);
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
      expect(parseSqaaRequestBody(sqaaCalls[0].body).projectKey).toBe(TEST_PROJECT);
    },
    { timeout: 15000 },
  );

  it(
    'resolves the project key from a linked git worktree using the main checkout registry entry',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      // Record the SQAA feature against the main checkout, as `sonar integrate` would.
      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      // Make the main checkout a git repo and add a linked worktree beside it.
      initGitRepo(harness.cwd.path);
      commitFile(harness.cwd.path, 'README.md', '# test\n');
      const worktreePath = join(dirname(harness.cwd.path), 'linked-worktree');
      git(['worktree', 'add', worktreePath, '-b', 'feature/x'], harness.cwd.path);
      writeFileSync(join(worktreePath, 'index.ts'), 'const x = 1;');

      // Run from the worktree, whose repo root never matches the registered projectRoot.
      const result = await harness.run('analyze agentic --file index.ts', { cwd: worktreePath });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('No issues found');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
      expect(parseSqaaRequestBody(sqaaCalls[0].body).projectKey).toBe(TEST_PROJECT);
    },
    { timeout: 15000 },
  );

  it(
    'resolves the project key from the main checkout when SQAA was integrated in a linked worktree',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      initGitRepo(harness.cwd.path);
      commitFile(harness.cwd.path, 'README.md', '# test\n');
      const worktreePath = join(dirname(harness.cwd.path), 'linked-worktree');
      git(['worktree', 'add', worktreePath, '-b', 'feature/y'], harness.cwd.path);

      // Record SQAA as if integrate ran inside the linked worktree.
      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl(), {
          targetRoot: worktreePath,
          repoRoot: harness.cwd.path,
        });

      writeFileSync(join(harness.cwd.path, 'index.ts'), 'const x = 1;');
      const result = await harness.run('analyze agentic --file index.ts');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('No issues found');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
      expect(parseSqaaRequestBody(sqaaCalls[0].body).projectKey).toBe(TEST_PROJECT);
    },
    { timeout: 15000 },
  );

  it(
    'prefers the current worktree SQAA feature when multiple worktrees registered different project keys',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      initGitRepo(harness.cwd.path);
      commitFile(harness.cwd.path, 'README.md', '# test\n');
      const worktreePath = join(dirname(harness.cwd.path), 'linked-worktree');
      git(['worktree', 'add', worktreePath, '-b', 'feature/z'], harness.cwd.path);

      const linkedProject = 'linked-worktree-project';
      const mainProject = 'main-checkout-project';
      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, mainProject, TEST_ORG, server.baseUrl(), {
          targetRoot: harness.cwd.path,
          repoRoot: harness.cwd.path,
        })
        .withSqaaFeature(harness.cwd.path, linkedProject, TEST_ORG, server.baseUrl(), {
          targetRoot: worktreePath,
          repoRoot: harness.cwd.path,
        });

      writeFileSync(join(worktreePath, 'index.ts'), 'const x = 1;');
      const result = await harness.run('analyze agentic --file index.ts', { cwd: worktreePath });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('No issues found');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
      expect(parseSqaaRequestBody(sqaaCalls[0].body).projectKey).toBe(linkedProject);
    },
    { timeout: 15000 },
  );

  it(
    'sends one multi-file DEEP request when multiple --file paths are given',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('a.ts', 'const a = 1;');
      harness.cwd.writeFile('b.ts', 'const b = 2;');

      const result = await harness.run(
        `analyze agentic --project ${TEST_PROJECT} --file a.ts --file b.ts`,
      );

      expect(result.exitCode).toBe(0);
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
      expect(sqaaRequestFileCount(sqaaCalls[0].body)).toBe(2);
      expect(allSqaaRequestsUseDeep(sqaaCalls)).toBe(true);
      expect(parseSqaaRequestBody(sqaaCalls[0].body).analysisDepth).toBe('DEEP');
      expect(result.stdout + result.stderr).toContain('DEEP analysis');
    },
    { timeout: 15000 },
  );

  it(
    'uses STANDARD depth when change-set is run with --depth STANDARD',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      initGitRepo(harness.cwd.path);
      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('new.ts', 'const x = 1;');

      const result = await harness.run(
        `analyze agentic --project ${TEST_PROJECT} --depth STANDARD`,
      );

      expect(result.exitCode).toBe(0);
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
      expect(parseSqaaRequestBody(sqaaCalls[0].body).analysisDepth).toBeUndefined();
      expect(result.stdout + result.stderr).toContain('STANDARD analysis');
    },
    { timeout: 15000 },
  );

  it(
    'uses STANDARD depth for multi --file when --depth STANDARD is set',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('a.ts', 'const a = 1;');
      harness.cwd.writeFile('b.ts', 'const b = 2;');

      const result = await harness.run(
        `analyze agentic --project ${TEST_PROJECT} --file a.ts --file b.ts --depth STANDARD`,
      );

      expect(result.exitCode).toBe(0);
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
      expect(parseSqaaRequestBody(sqaaCalls[0].body).analysisDepth).toBeUndefined();
      expect(result.stdout + result.stderr).toContain('STANDARD analysis');
    },
    { timeout: 15000 },
  );

  it(
    'uses DEEP depth for single --file when --depth DEEP is set',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run(
        `analyze agentic --project ${TEST_PROJECT} --file src/index.ts --depth DEEP`,
      );

      expect(result.exitCode).toBe(0);
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
      expect(parseSqaaRequestBody(sqaaCalls[0].body).analysisDepth).toBe('DEEP');
      expect(result.stdout + result.stderr).toContain('DEEP analysis');
    },
    { timeout: 15000 },
  );

  it(
    'includes analysisDepth in JSON report output',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run(
        `analyze agentic --project ${TEST_PROJECT} --file src/index.ts --format json`,
      );

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout) as { analysisDepth: string };
      expect(report.analysisDepth).toBe('STANDARD');
    },
    { timeout: 15000 },
  );

  it(
    'rejects invalid --depth values',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      const result = await harness.run(`analyze agentic --project ${TEST_PROJECT} --depth QUICK`);

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Allowed choices are STANDARD, DEEP');
    },
    { timeout: 15000 },
  );

  it(
    'calls SQAA API and displays found issues with line numbers',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({
          issues: [
            { rule: 'python:S1234', message: 'Refactor this method', startLine: 5 },
            { rule: 'python:S5678', message: 'Remove this unused variable' },
          ],
        })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('main.py', 'def foo():\n  pass\n');

      const result = await harness.run('analyze agentic --file main.py');

      expect(result.exitCode).toBe(51);
      const output = result.stdout + result.stderr;
      expect(output).toContain('2 issues');
      expect(output).toContain('Refactor this method');
      expect(output).toContain('line 5');
      expect(output).toContain('python:S1234');
    },
    { timeout: 15000 },
  );

  it(
    'calls SQAA API and displays API-level errors',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({
          issues: [],
          errors: [{ code: 'NOT_ENTITLED', message: 'Organization is not entitled to SQAA' }],
        })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze agentic --file src/index.ts');

      expect(result.exitCode).toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain('NOT_ENTITLED');
      expect(output).toContain('not entitled');
      expect(output).not.toContain('No issues found');
    },
    { timeout: 15000 },
  );
});

describe('analyze agentic — analysis telemetry', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function enableFlushTelemetry(): void {
    harness.withExtraEnv({ [TELEMETRY_FLUSH_MODE_ENV]: '1' });
  }

  it(
    'writes CliAnalysisCompleted to telemetry-events.ndjson on a clean run',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      enableFlushTelemetry();
      harness
        .state()
        .withTelemetryEnabled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze agentic --file src/index.ts');

      expect(result.exitCode).toBe(0);
      const events = readAnalysisEvents(harness.sonarUserHome.path);
      expect(events).toHaveLength(1);
      expect(events[0].metadata.event_type).toBe('Analytics.Cli.CliAnalysisCompleted');
      const completed = events[0];
      expect(completed.event_payload.caller_command).toBe(SQAA_ANALYZE_AGENTIC_CALLER_COMMAND);
      expect(completed.event_payload.analyzer).toBe('sqaa');
      expect(completed.event_payload.findings_count).toBe(0);
      expect(completed.event_payload.exit_code).toBe(0);
      expect(completed.event_payload.errors_count).toBe(0);
      expect(completed.event_payload.failures_count).toBe(0);
      expect(completed.event_payload.scan_duration_ms).toBeGreaterThanOrEqual(0);
      expect(completed.event_payload.analysis_id).toMatch(/^[0-9a-f-]{36}$/);
    },
    { timeout: 15000 },
  );

  it(
    'writes a single CliAnalysisCompleted with populated details when issues are found',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({
          issues: [
            { rule: 'typescript:S1234', message: 'Fix this', startLine: 1 },
            { rule: 'typescript:S1234', message: 'Fix that', startLine: 2 },
          ],
        })
        .start();

      enableFlushTelemetry();
      harness
        .state()
        .withTelemetryEnabled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;\nconst y = 2;\n');

      const result = await harness.run('analyze agentic --file src/index.ts');

      expect(result.exitCode).toBe(EXIT_CODE_SECRETS_FOUND);
      const events = readAnalysisEvents(harness.sonarUserHome.path);
      expect(events).toHaveLength(1);
      const [completed] = events;
      expect(completed.event_payload.findings_count).toBe(2);
      expect(completed.event_payload.exit_code).toBe(EXIT_CODE_SECRETS_FOUND);
      expect(JSON.parse(completed.event_payload.details)).toEqual({
        rule_keys: ['typescript:S1234'],
        counts_by_rule: { 'typescript:S1234': 2 },
      });
    },
    { timeout: 15000 },
  );

  it(
    'resolves and records a non-null project_uuid on CliCommandExecuted',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .withProject(TEST_PROJECT)
        .start();

      // Deliberately do NOT set TELEMETRY_FLUSH_MODE_ENV: it makes storeEvent() (which owns
      // CliCommandExecuted) no-op, since it also doubles as the guard that stops the detached
      // flush worker from recursively emitting its own CliCommandExecuted event.
      harness
        .state()
        .withTelemetryEnabled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze agentic --file src/index.ts');

      expect(result.exitCode).toBe(0);
      const [analysisEvent] = readAnalysisEvents(harness.sonarUserHome.path);
      expect(analysisEvent.event_payload.analyzer).toBe('sqaa');

      // project_uuid lives only on CliCommandExecuted; the analysis event above is joined to
      // it on the shared invocation_id.
      const [commandEvent] = readCommandEvents(harness.sonarUserHome.path);
      expect(commandEvent.event_payload.command).toBe('analyze');
      expect(commandEvent.event_payload.invocation_id).toBe(
        analysisEvent.event_payload.invocation_id,
      );
      expect(commandEvent.event_payload.project_uuid).toBe(`AY${TEST_PROJECT}legacy`);
    },
    { timeout: 15000 },
  );
});

describe('sonar analyze — analysis telemetry', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function enableFlushTelemetry(): void {
    harness.withExtraEnv({ [TELEMETRY_FLUSH_MODE_ENV]: '1' });
  }

  function readCompletedEventsForAnalyzer(
    analyzer: 'sqaa' | 'sonar-secrets',
  ): StoredAnalysisCompletedEvent[] {
    return readAnalysisEvents(harness.sonarUserHome.path).filter(
      (event) => event.event_payload.analyzer === analyzer,
    );
  }

  it(
    'writes separate CliAnalysisCompleted events for secrets and sqaa on bare analyze --file (text)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      enableFlushTelemetry();
      harness
        .state()
        .withTelemetryEnabled()
        .withSecretsBinaryInstalled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze --file src/index.ts');

      expect(result.exitCode).toBe(0);
      const secretsEvents = readCompletedEventsForAnalyzer('sonar-secrets');
      const sqaaEvents = readCompletedEventsForAnalyzer('sqaa');
      expect(secretsEvents).toHaveLength(1);
      expect(sqaaEvents).toHaveLength(1);
      expect(secretsEvents[0].event_payload.caller_command).toBe(SECRETS_CALLER_COMMANDS.analyze);
      expect(sqaaEvents[0].event_payload.caller_command).toBe(SQAA_ANALYZE_CALLER_COMMAND);
      expect(secretsEvents[0].event_payload.findings_count).toBe(0);
      expect(sqaaEvents[0].event_payload.findings_count).toBe(0);
    },
    { timeout: 30000 },
  );

  it(
    'writes CliAnalysisCompleted with caller_command analyze on bare analyze --format json --file',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      enableFlushTelemetry();
      harness
        .state()
        .withTelemetryEnabled()
        .withSecretsBinaryInstalled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze --format json --file src/index.ts');

      expect(result.exitCode).toBe(0);
      const secretsEvents = readCompletedEventsForAnalyzer('sonar-secrets');
      const sqaaEvents = readCompletedEventsForAnalyzer('sqaa');
      expect(secretsEvents).toHaveLength(1);
      expect(sqaaEvents).toHaveLength(1);
      expect(secretsEvents[0].event_payload.caller_command).toBe(SECRETS_CALLER_COMMANDS.analyze);
      expect(sqaaEvents[0].event_payload.caller_command).toBe(SQAA_ANALYZE_CALLER_COMMAND);
    },
    { timeout: 30000 },
  );

  it(
    'records a non-null project_uuid on CliCommandExecuted for bare analyze --file (text)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .withProject(TEST_PROJECT)
        .start();

      // Do NOT enable flush mode: TELEMETRY_FLUSH_MODE_ENV no-ops storeEvent(), which owns
      // CliCommandExecuted, so the command event would never be written.
      harness
        .state()
        .withTelemetryEnabled()
        .withSecretsBinaryInstalled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze --file src/index.ts');

      expect(result.exitCode).toBe(0);
      const [analysisEvent] = readCompletedEventsForAnalyzer('sqaa');

      const [commandEvent] = readCommandEvents(harness.sonarUserHome.path);
      expect(commandEvent.event_payload.invocation_id).toBe(
        analysisEvent.event_payload.invocation_id,
      );
      expect(commandEvent.event_payload.command).toBe('analyze');
      expect(commandEvent.event_payload.project_uuid).toBe(`AY${TEST_PROJECT}legacy`);
    },
    { timeout: 30000 },
  );

  it(
    'records a non-null project_uuid on CliCommandExecuted for bare analyze --format json --file',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .withProject(TEST_PROJECT)
        .start();

      harness
        .state()
        .withTelemetryEnabled()
        .withSecretsBinaryInstalled()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze --format json --file src/index.ts');

      expect(result.exitCode).toBe(0);
      const [commandEvent] = readCommandEvents(harness.sonarUserHome.path);
      expect(commandEvent.event_payload.command).toBe('analyze');
      expect(commandEvent.event_payload.project_uuid).toBe(`AY${TEST_PROJECT}legacy`);
    },
    { timeout: 30000 },
  );
});

describe('analyze agentic — change-set mode (no --file)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    // All change-set tests need a real git repo in cwd.
    initGitRepo(harness.cwd.path);
    // Ignore harness-internal files the CLI binary may create in cwd (e.g. .claude/).
    commitFile(harness.cwd.path, '.gitignore', '.claude/\n');
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 0 and reports no files when change set is empty',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      // Empty repo: first commit with no changes after it.
      commitFile(harness.cwd.path, 'README.md', 'hello');

      const result = await harness.run('analyze agentic');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('no files in the change set');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'default mode: analyzes unstaged modified files vs HEAD',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'app.ts', 'const a = 1;');
      // Modify without staging — should appear in `git diff HEAD`
      harness.cwd.writeFile('app.ts', 'const a = 2;');

      const result = await harness.run('analyze agentic');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('No issues found');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'default mode: includes untracked non-ignored files',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      // New untracked file — not in any commit, not ignored
      harness.cwd.writeFile('new-feature.ts', 'export const x = 1;');

      const result = await harness.run('analyze agentic');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('No issues found');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'default mode: excludes git-ignored files',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      // Append dist/ to the existing .gitignore (already committed in beforeEach)
      commitFile(harness.cwd.path, '.gitignore', '.claude/\ndist/\n');
      harness.cwd.writeFile('dist/bundle.js', 'console.log("built");');

      const result = await harness.run('analyze agentic');

      expect(result.exitCode).toBe(0);
      // No files to analyze (ignored file excluded, nothing else changed)
      expect(result.stdout + result.stderr).toContain('no files in the change set');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 when --staged and --base are combined',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      commitFile(harness.cwd.path, 'README.md', 'hello');

      const result = await harness.run('analyze agentic --staged --base main');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain(
        '--staged and --base cannot be used together',
      );
    },
    { timeout: 15000 },
  );

  it(
    'warns but auto-proceeds in non-TTY when change set exceeds the large-set threshold',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      for (let i = 1; i <= 51; i++) {
        harness.cwd.writeFile(`file${i}.ts`, `const x${i} = ${i};`);
      }

      const result = await harness.run('analyze agentic');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('large number of files (51)');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
      expect(sqaaRequestFileCount(sqaaCalls[0].body)).toBe(51);
      expect(allSqaaRequestsUseDeep(sqaaCalls)).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'skips the large change set warning with --force',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      for (let i = 1; i <= 51; i++) {
        harness.cwd.writeFile(`file${i}.ts`, `const x${i} = ${i};`);
      }

      const result = await harness.run('analyze agentic --force');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).not.toContain('large number of files');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
      expect(totalSqaaFilesSent(sqaaCalls)).toBe(51);
    },
    { timeout: 30000 },
  );

  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])(
    'prints a non-interactive hint before the large change set confirmation only for a detected AI agent without --force (isAgent=%s, isInteractive=%s, expectedShownPrompt=%s)',
    async (isAgent, isInteractive, expectedShownPrompt) => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      for (let i = 1; i <= 51; i++) {
        harness.cwd.writeFile(`file${i}.ts`, `const x${i} = ${i};`);
      }

      const result = await harness.run(`analyze agentic${isInteractive ? '' : ' --force'}`, {
        ...(isInteractive ? { stdinChunks: ['\r'] } : {}),
        extraEnv: {
          SONARQUBE_CLI_MOCK_TTY: '1',
          ...(isAgent ? { CLAUDECODE: '1' } : {}),
        },
      });

      expect(result.exitCode).toBe(0);
      if (expectedShownPrompt) {
        expectAgentPromptHint(result.stdout, 'sonar analyze --force');
      } else {
        expectNoAgentPromptHint(result.stdout);
      }
    },
    { timeout: 30000 },
  );

  it(
    'does not print a non-interactive hint for a detected AI agent when the change set is below the large-set threshold',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');

      const result = await harness.run('analyze agentic', {
        extraEnv: { SONARQUBE_CLI_MOCK_TTY: '1', CLAUDECODE: '1' },
      });

      expect(result.exitCode).toBe(0);
      expectNoAgentPromptHint(result.stdout);
    },
    { timeout: 30000 },
  );

  it(
    'splits on 413 using server-reported payload limits',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .withSqaaPayloadLimit({ maxRequestSize: 5 * 1024 * 1024 })
        .start();
      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      const largeContent = 'x'.repeat(4 * 1024 * 1024);
      harness.cwd.writeFile('large-a.ts', largeContent);
      harness.cwd.writeFile('large-b.ts', largeContent);
      harness.cwd.writeFile('large-c.ts', largeContent);

      const result = await harness.run('analyze agentic --force');

      expect(result.exitCode).toBe(0);
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(4);
      expect(sqaaRequestFileCount(sqaaCalls[0]?.body)).toBe(3);
      for (const call of sqaaCalls.slice(1)) {
        expect(sqaaRequestFileCount(call.body)).toBe(1);
      }
      expect(allSqaaRequestsUseDeep(sqaaCalls)).toBe(true);
    },
    { timeout: 60000 },
  );

  it(
    '--staged: analyzes only staged files',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      stageFile(harness.cwd.path, 'staged.ts', 'const s = 1;');
      // Unstaged modification — should not be included
      harness.cwd.writeFile('unstaged.ts', 'const u = 1;');

      const result = await harness.run('analyze agentic --staged');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('No issues found');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    '--staged: exits with code 0 and no API call when nothing is staged',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');

      const result = await harness.run('analyze agentic --staged');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('no files in the change set');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    '--base <branch>: analyzes files changed vs base branch',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      // Establish a base commit on master
      commitFile(harness.cwd.path, 'base.ts', 'const base = 1;');
      // Create a feature branch and add a new file
      git(['checkout', '-b', 'feature'], harness.cwd.path);
      commitFile(harness.cwd.path, 'feature.ts', 'const f = 1;');

      const result = await harness.run('analyze agentic --base master');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('No issues found');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 51 when issues are found in change-set',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({
          issues: [{ rule: 'ts:S1234', message: 'Fix this', startLine: 1 }],
        })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('dirty.ts', 'const x = 1;');

      const result = await harness.run('analyze agentic');

      expect(result.exitCode).toBe(51);
      expect(result.stdout + result.stderr).toContain('Fix this');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and skips SQAA for on-premise server in change-set mode',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN); // no orgKey → on-premise

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('app.ts', 'const a = 1;');

      const result = await harness.run('analyze agentic');

      expect(result.exitCode).toBe(0);
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when no project is configured in change-set mode',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      // Cloud auth but no extension registered → no projectKey in registry → error
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('app.ts', 'const a = 1;');

      const result = await harness.run('analyze agentic');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        'Vortex agentic analysis requires a project, but none is configured for this directory.',
      );
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and skips agentic gracefully for the bare `analyze` command when no project is configured',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      // Cloud auth but no extension registered. The bare `analyze` catch-all must
      // still skip agentic gracefully (Option A) rather than failing the command.
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('app.ts', 'const a = 1;');

      const result = await harness.run('analyze');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'Vortex agentic analysis skipped: no project configured',
      );
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'excludes binary files from the change set',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      // Write a file with a NUL byte — detected as binary and excluded
      writeFileSync(join(harness.cwd.path, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x4e]));

      const result = await harness.run('analyze agentic');

      expect(result.exitCode).toBe(0);
      // Binary file shown as IGNORED — no files to analyze
      expect(result.stdout + result.stderr).toContain('all change set files were excluded');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'excludes files that exceed the 10 MB size limit',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      // Write a file slightly over 10 MB
      writeFileSync(join(harness.cwd.path, 'huge.ts'), Buffer.alloc(10 * 1024 * 1024 + 1, 'a'));

      const result = await harness.run('analyze agentic');

      expect(result.exitCode).toBe(0);
      // Oversized file shown as IGNORED — no files to analyze
      expect(result.stdout + result.stderr).toContain('all change set files were excluded');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'does not report "No issues found" when the API returned errors for every file',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({
          issues: [],
          errors: [{ code: 'NOT_ENTITLED', message: 'Organization is not entitled to SQAA' }],
        })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      stageFile(harness.cwd.path, 'staged.ts', 'const s = 1;');

      const result = await harness.run('analyze agentic --staged');

      const output = result.stdout + result.stderr;
      expect(output).toContain('NOT_ENTITLED');
      // No issues were reported, so exit code must not be 51.
      expect(result.exitCode).not.toBe(51);
      // When the server returned errors for every file, don't mislead the user with "clean".
      expect(output).not.toContain('No issues found');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when the cwd is not a git repository',
    async () => {
      // Create a second harness whose cwd is not a git repo (no initGitRepo called).
      const bareHarness = await TestHarness.create();
      const server = await bareHarness.newFakeServer().withAuthToken(VALID_TOKEN).start();

      bareHarness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(bareHarness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      bareHarness.cwd.writeFile('app.ts', 'const a = 1;');

      const result = await bareHarness.run('analyze agentic');

      await bareHarness.dispose();

      // resolveChangeSet → resolveRepoRoot fails outside a git repo → CommandFailedError → exit 1
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Not inside a git repository');
    },
    { timeout: 15000 },
  );
});

describe('verify — change-set mode (no --file)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    initGitRepo(harness.cwd.path);
    commitFile(harness.cwd.path, '.gitignore', '.claude/\n');
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'default mode: analyzes untracked files and reports no issues',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('new.ts', 'const x = 1;');

      const result = await harness.run('verify');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('No issues found');
      expect(result.stderr).toContain('deprecated');
      expect(result.stderr).toContain('sonar analyze');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    '--staged: analyzes only staged files',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      stageFile(harness.cwd.path, 'staged.ts', 'const s = 1;');
      harness.cwd.writeFile('unstaged.ts', 'const u = 1;');

      const result = await harness.run('verify --staged');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('No issues found');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      // Only staged.ts is sent — unstaged.ts is excluded
      expect(sqaaCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'warns but auto-proceeds in non-TTY when change set exceeds the large-set threshold',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      for (let i = 1; i <= 51; i++) {
        harness.cwd.writeFile(`file${i}.ts`, `const x${i} = ${i};`);
      }

      const result = await harness.run('verify');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('large number of files (51)');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
      expect(sqaaRequestFileCount(sqaaCalls[0].body)).toBe(51);
      expect(allSqaaRequestsUseDeep(sqaaCalls)).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'skips the large change set warning with --force',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      for (let i = 1; i <= 51; i++) {
        harness.cwd.writeFile(`file${i}.ts`, `const x${i} = ${i};`);
      }

      const result = await harness.run('verify --force');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).not.toContain('large number of files');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
      expect(totalSqaaFilesSent(sqaaCalls)).toBe(51);
    },
    { timeout: 30000 },
  );
});

describe('analyze agentic — API error codes', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 and shows rate-limit message on 429',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaStatusCode(429)
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze agentic --file src/index.ts');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Rate limit reached');
      expect(result.stdout + result.stderr).toContain('  → Wait a moment and try again.');
    },
    { timeout: 15000 },
  );

  it(
    'retries 3 times on 503 then exits with code 1',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaStatusCode(503)
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze agentic --file src/index.ts');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('still unavailable');
      expect(result.stdout + result.stderr).toContain(
        '  → Check your network connection and try again later.',
      );
      // 4 total attempts: 1 initial + 3 retries
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(4);
    },
    { timeout: 15000 },
  );

  it(
    'retries 503 per chunk in change-set mode',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaStatusCode(503)
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      initGitRepo(harness.cwd.path);
      commitFile(harness.cwd.path, '.gitignore', '.claude/\n');
      harness.cwd.writeFile('a.ts', 'const a = 1;');
      harness.cwd.writeFile('b.ts', 'const b = 2;');

      const result = await harness.run('analyze agentic');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Server busy');
      // One chunk with two files: 1 initial + 3 retries = 4 attempts.
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(4);
      expect(sqaaRequestFileCount(sqaaCalls[0].body)).toBe(2);
    },
    { timeout: 15000 },
  );

  it(
    'outputs errors to stderr and results to stdout',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [{ rule: 'ts:S1135', message: 'TODO', startLine: 1 }] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', '// TODO: fix\nconst x = 1;');

      const result = await harness.run('analyze agentic --file src/index.ts');

      expect(result.exitCode).toBe(51);
      // Issue details are on stdout.
      expect(result.stdout).toContain('TODO');
      // No Sonar error text should appear on stdout.
      expect(result.stdout).not.toContain('❌ Vortex agentic analysis failed');
    },
    { timeout: 15000 },
  );
});

describe('analyze agentic — --format json', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    initGitRepo(harness.cwd.path);
    commitFile(harness.cwd.path, '.gitignore', '.claude/\n');
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'outputs valid JSON report for a clean single file',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze agentic --file src/index.ts --format json');

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout) as {
        files: { path: string; issues: unknown[] }[];
        ignored: unknown[];
        failures: unknown[];
        summary: { totalIssues: number; totalFailures: number };
      };
      expect(report.files).toHaveLength(1);
      expect(report.files[0].path).toBe('src/index.ts');
      expect(report.files[0].issues).toHaveLength(0);
      expect(report.ignored).toHaveLength(0);
      expect(report.failures).toHaveLength(0);
      expect(report.summary.totalIssues).toBe(0);
      expect(report.summary.totalFailures).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'outputs valid JSON report with issues for single file',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({
          issues: [{ rule: 'ts:S1135', message: 'Fix this TODO', startLine: 1 }],
        })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', '// TODO: fix\nconst x = 1;');

      const result = await harness.run('analyze agentic --file src/index.ts --format json');

      expect(result.exitCode).toBe(51);
      const report = JSON.parse(result.stdout) as {
        files: { path: string; issues: { rule: string; message: string }[] }[];
        summary: { totalIssues: number };
      };
      expect(report.files[0].issues).toHaveLength(1);
      expect(report.files[0].issues[0].rule).toBe('ts:S1135');
      expect(report.summary.totalIssues).toBe(1);
    },
    { timeout: 15000 },
  );

  it(
    'outputs valid JSON report for change-set mode with ignored files',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('src/index.ts', 'const x = 1;');
      // Binary file — should appear in ignored
      writeFileSync(join(harness.cwd.path, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x4e]));

      const result = await harness.run('analyze agentic --format json');

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout) as {
        files: { path: string }[];
        ignored: { path: string; reason: string }[];
        failures: unknown[];
        summary: { totalIssues: number; totalFailures: number };
      };
      expect(report.files).toHaveLength(1);
      expect(report.files[0].path).toBe('src/index.ts');
      expect(report.ignored).toHaveLength(1);
      expect(report.ignored[0].reason).toBe('binary');
      expect(report.failures).toHaveLength(0);
      expect(report.summary.totalIssues).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'JSON report lists all files as failures when a chunk fails (no per-file skip bucket)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaStatusCode(429)
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      for (let i = 1; i <= 51; i++) {
        harness.cwd.writeFile(`file${i}.ts`, `const x${i} = ${i};`);
      }

      const result = await harness.run('analyze agentic --format json');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).not.toContain('large number of files');

      const report = JSON.parse(result.stdout) as {
        files: unknown[];
        failures: { path: string; message: string }[];
        skipped: string[];
        summary: { totalIssues: number; totalFailures: number; totalSkipped: number };
      };
      expect(report.failures).toHaveLength(51);
      expect(report.skipped).toHaveLength(0);
      expect(report.summary.totalSkipped).toBe(0);
      expect(report.files.length + report.failures.length + report.skipped.length).toBe(51);
    },
    { timeout: 30000 },
  );

  it(
    'JSON report surfaces API error as failure entry for single file (--file --format json)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaStatusCode(HTTP_TOO_MANY_REQUESTS)
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze agentic --file src/index.ts --format json');

      expect(result.exitCode).toBe(1);
      const report = JSON.parse(result.stdout) as {
        files: unknown[];
        failures: { path: string; message: string }[];
        summary: { totalIssues: number; totalFailures: number };
      };
      expect(report.files).toHaveLength(0);
      expect(report.failures).toHaveLength(1);
      expect(report.failures[0].path).toBe('src/index.ts');
      expect(report.failures[0].message).toBeTruthy();
      expect(report.summary.totalFailures).toBe(1);
    },
    { timeout: 15000 },
  );

  it(
    'single oversized file exits 1 with structured 413 message (--file)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .withSqaaPayloadLimit({ maxRequestSize: 64 })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('large.ts', 'x'.repeat(256));

      const result = await harness.run('analyze agentic --file large.ts');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('Request payload too large');
      expect(output).toContain('→ Reduce file sizes');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );
});

describe('analyze agentic — running from a subdirectory', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    initGitRepo(harness.cwd.path);
    commitFile(harness.cwd.path, '.gitignore', '.claude/\n');
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'resolves repo-root project key and full change set when invoked from a subdirectory',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        // Extension is registered against the repo root, just like `sonar integrate claude` does.
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      // One change above and one below the subdirectory, so we cover both
      // sides of the previous join(cwd, repoRelativePath) bug.
      harness.cwd.writeFile('top-level.ts', 'export const a = 1;');
      harness.cwd.writeFile('src/ui/inside.ts', 'export const b = 2;');

      const subdir = join(harness.cwd.path, 'src', 'ui');
      const result = await harness.run('analyze agentic', { cwd: subdir });

      expect(result.exitCode).toBe(0);
      const output = result.stdout + result.stderr;
      // Project must still be found — no fallthrough to the "no project configured" warning.
      expect(output).not.toContain('no project configured');
      expect(output).toContain('No issues found');

      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
      expect(sqaaRequestFileCount(sqaaCalls[0].body)).toBe(2);
      expect(allSqaaRequestsUseDeep(sqaaCalls)).toBe(true);

      const request = parseSqaaRequestBody(sqaaCalls[0].body);
      const filePaths = (request.files ?? []).map((f) => f.path).sort();
      expect(filePaths).toEqual(['src/ui/inside.ts', 'top-level.ts']);
    },
    { timeout: 15000 },
  );

  it(
    'handles paths containing whitespace via -z parsing',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      // Filename with a space — would be corrupted by the previous `.trim()`-based parser.
      harness.cwd.writeFile('with space.ts', 'export const x = 1;');

      const result = await harness.run('analyze agentic');

      expect(result.exitCode).toBe(0);
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
      expect(sqaaRequestFirstFilePath(sqaaCalls[0].body)).toBe('with space.ts');
    },
    { timeout: 15000 },
  );
});
