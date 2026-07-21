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

// Integration tests for `analyze secrets`.
//
// Note: hardcoded token below is an intentional test fixture for the secret scanner.
// sonar-ignore-next-line S6769

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildLocalBinaryName } from '../../../../src/commands/_common/install/secrets.js';
import { detectPlatform } from '../../../../src/lib/platform-detector.js';
import { readAnalysisEvents } from '../../../_common/telemetry-helpers';
import { TestHarness } from '../../harness';

// Hardcoded test token — intentional fixture for secret detection, not a real credential
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
const CLEAN_CONTENT = 'const greeting = "hello world";';
const VALID_TOKEN = 'integration-test-token';
const EXIT_CODE_SECRETS_FOUND = 51;

// Placeholder server URL for tests that need to pass the auth gate but don't call a real server.
// The binary handles unreachable auth URLs gracefully (quick connection-refused, scan proceeds).
const FAKE_SERVER = 'http://localhost:19999';

describe('analyze secrets', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 when not authenticated',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.cwd.writeFile('clean.js', CLEAN_CONTENT);

      const result = await harness.run('analyze secrets clean.js');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('❌ Not authenticated.');
      expect(output).toContain("  → Run 'sonar auth login' to authenticate.");
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 for clean file when binary is installed',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');
      harness.cwd.writeFile('clean.js', CLEAN_CONTENT);

      const result = await harness.run('analyze secrets clean.js');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('No issues found');
    },
    { timeout: 30000 },
  );

  it(
    'exits with code 51 for file with secrets when binary is installed',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');
      harness.cwd.writeFile('secrets.js', `const token = "${GITHUB_TEST_TOKEN}";`);

      const result = await harness.run('analyze secrets secrets.js');

      expect(result.exitCode).toBe(EXIT_CODE_SECRETS_FOUND);
      // Binary reports auth failure when credentials point to an unreachable server
      expect(result.stdout + result.stderr).toContain('Authentication was not successful');
      expect(result.stdout + result.stderr).toContain('GitHub Token');
    },
    { timeout: 30000 },
  );

  it(
    'exits with code 0 for clean content via --stdin when binary is installed',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.run('analyze secrets --stdin', { stdin: CLEAN_CONTENT });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('No issues found');
    },
    { timeout: 30000 },
  );

  it(
    'exits with code 51 for content with secrets via --stdin when binary is installed',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.run('analyze secrets --stdin', {
        stdin: `const token = "${GITHUB_TEST_TOKEN}";`,
      });

      expect(result.exitCode).toBe(EXIT_CODE_SECRETS_FOUND);
      // Binary reports auth failure when credentials point to an unreachable server
      expect(result.stdout + result.stderr).toContain('Authentication was not successful');
      expect(result.stdout + result.stderr).toContain('GitHub Token');
    },
    { timeout: 30000 },
  );

  it(
    'auto-installs sonar-secrets and scans when binary is absent',
    async () => {
      await harness.newFakeBinariesServer().start();
      harness.withAuth(FAKE_SERVER, 'fake-token');
      harness.cwd.writeFile('clean.js', CLEAN_CONTENT);

      const result = await harness.run('analyze secrets clean.js');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('No issues found');
      expect(harness.cliHome.file('bin', buildLocalBinaryName(detectPlatform())).exists()).toBe(
        true,
      );
      const state = harness.stateJsonFile.asJson() as {
        tools: { installed: Array<{ name: string; version: string }> };
      };
      const recorded = state.tools.installed.find((t) => t.name === 'sonar-secrets');
      expect(recorded).toBeDefined();
      expect(recorded?.version).toBeDefined();
    },
    { timeout: 30000 },
  );

  it(
    'aborts when sonar-secrets download fails',
    async () => {
      await harness.newFakeBinariesServer().noArtifacts().start();
      harness.withAuth(FAKE_SERVER, 'fake-token');
      harness.cwd.writeFile('clean.js', CLEAN_CONTENT);

      const result = await harness.run('analyze secrets clean.js');

      expect(result.exitCode).not.toBe(0);
      expect(harness.cliHome.file('bin', 'sonar-secrets').exists()).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'exits with code 2 when neither paths nor --stdin is provided',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.run('analyze secrets');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain(
        'Either provide file/directory paths or --stdin',
      );
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 for non-existent file path',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.run('analyze secrets /nonexistent/path/file.txt');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain('Path not found');
    },
    { timeout: 15000 },
  );

  it(
    'forwards auth to binary when SONARQUBE_CLI_TOKEN + SONARQUBE_CLI_SERVER are set',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();

      // Use a file with secrets so the binary outputs exit 51 and CLI forwards binary stderr.
      // With valid auth the binary must NOT report "Authentication was not successful".
      harness.cwd.writeFile('secrets.js', `const token = "${GITHUB_TEST_TOKEN}";`);

      const result = await harness.run('analyze secrets secrets.js', {
        extraEnv: {
          SONARQUBE_CLI_TOKEN: VALID_TOKEN,
          SONARQUBE_CLI_SERVER: server.baseUrl(),
          SONAR_SECRETS_ALLOW_UNSECURE_HTTP: 'true',
        },
      });

      expect(result.exitCode).toBe(EXIT_CODE_SECRETS_FOUND);
      expect(result.stdout + result.stderr).not.toContain('Authentication was not successful');
      expect(result.stdout + result.stderr).toContain('GitHub Token');
    },
    { timeout: 30000 },
  );

  it(
    'exits with code 2 when both paths and --stdin are provided',
    async () => {
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.run('analyze secrets somefile.js --stdin');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain('Cannot use both paths and --stdin');
    },
    { timeout: 15000 },
  );

  it(
    'forwards auth from active connection and keychain to binary',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();

      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(server.baseUrl(), VALID_TOKEN);

      // Use a file with secrets so the binary outputs exit 51 and CLI forwards binary stderr.
      // With valid auth the binary must NOT report "Authentication was not successful".
      harness.cwd.writeFile('secrets.js', `const token = "${GITHUB_TEST_TOKEN}";`);

      const result = await harness.run('analyze secrets secrets.js', {
        extraEnv: { SONAR_SECRETS_ALLOW_UNSECURE_HTTP: 'true' },
      });

      expect(result.exitCode).toBe(EXIT_CODE_SECRETS_FOUND);
      expect(result.stdout + result.stderr).not.toContain('Authentication was not successful');
      expect(result.stdout + result.stderr).toContain('GitHub Token');
    },
    { timeout: 30000 },
  );

  it(
    'writes a single CliAnalysisCompleted with populated details to telemetry-events.ndjson from a real scan',
    async () => {
      harness.state().withSecretsBinaryInstalled().withTelemetryEnabled();
      harness.withAuth(FAKE_SERVER, 'fake-token');
      // Run in flush-worker mode so storeEvent() never spawns the detached flush worker:
      // telemetry-events.ndjson is written but nothing is POSTed to the telemetry endpoint.
      harness.withExtraEnv({ __SQ_CLI_TELEMETRY_FLUSH__: '1' });
      harness.cwd.writeFile('secrets.js', `const token = "${GITHUB_TEST_TOKEN}";`);

      const result = await harness.run('analyze secrets secrets.js');
      expect(result.exitCode).toBe(EXIT_CODE_SECRETS_FOUND);

      const events = readAnalysisEvents(harness.sonarUserHome.path);

      // Exactly one completed event, carrying the details blob when findings are present.
      expect(events).toHaveLength(1);
      const [completed] = events;
      expect(completed.event_payload.analyzer).toBe('sonar-secrets');
      expect(completed.event_payload.caller_command).toBe('analyze secrets');
      expect(completed.event_payload.failures_count).toBe(0);
      expect(completed.event_payload.exit_code).toBe(EXIT_CODE_SECRETS_FOUND);
      expect(completed.event_payload.findings_count).toBeGreaterThanOrEqual(1);

      const details = JSON.parse(completed.event_payload.details) as {
        counts_by_rule: Record<string, number>;
        files_with_findings_count: number;
        source: string;
      };
      expect(Object.keys(details.counts_by_rule).length).toBeGreaterThanOrEqual(1);
      expect(details.source).toBe('files');
    },
    { timeout: 30000 },
  );

  it(
    'reports an unknown subcommand with a "Did you mean?" suggestion',
    async () => {
      const result = await harness.run('analyze secret');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain("error: unknown command 'secret'");
      expect(output).toContain('(Did you mean secrets?)');
    },
    { timeout: 15000 },
  );
});
