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

// Integration tests for `analyze dependency-risks`: pre-flight gates
// (authentication, SCA availability, project existence) plus the happy path,
// which currently runs against the no-op scanner runner and emits an empty
// list of dependency risks. Once the real scanner is wired, the happy-path
// assertions will be expanded.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { buildLocalBinaryName } from '@/core/host/install/sca-scanner.ts';

import { readCommandEvents } from '../../../_common/telemetry-helpers';
import { TestHarness } from '../../harness';

const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';
const MANIFEST_DISCOVERY_FAILURE_PREFIX = 'Manifest discovery error: sca-scanner exited with code';

describe('analyze dependency-risks', () => {
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
      const result = await harness.run('analyze dependency-risks --project demo');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('❌ Not authenticated.');
      expect(output).toContain("  → Run 'sonar auth login' to authenticate.");
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when project does not exist (settings 404)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withScaEnabled(true)
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run('analyze dependency-risks --project demo');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain("Project 'demo' not found");
      expect(server.getRecordedRequests().some((r) => r.path === '/api/settings/values')).toBe(
        true,
      );
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when SCA is disabled on the server',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withScaEnabled(false)
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run('analyze dependency-risks --project demo');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        'Software Composition Analysis is not available for the current connection.',
      );
    },
    { timeout: 15000 },
  );

  // The next two tests assert on scanner *failure* because the in-process
  // fake server does not implement the SCA-scanner backend APIs.
  // The failure surfaces during the secrets pre-scan's `discover-manifests` step.
  // Happy-path coverage against a real backend lives in the credential-gated
  // SonarQube Cloud staging suite at `tests/e2e/sca/sca-staging.test.ts`.
  it(
    'reports a scanner failure when the SCA backend is unavailable',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withScaEnabled(true)
        .withProject('demo')
        .withProjectSettings('demo', [])
        .start();
      harness.state().withScaScannerBinaryInstalled();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run('analyze dependency-risks --project demo --format json', {
        timeoutMs: 30_000,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(MANIFEST_DISCOVERY_FAILURE_PREFIX);
    },
    { timeout: 30000 },
  );

  it(
    'routes progress to stderr and keeps stdout free of progress noise',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withScaEnabled(true)
        .withProject('demo')
        .withProjectSettings('demo', [])
        .start();
      harness.state().withScaScannerBinaryInstalled();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run('analyze dependency-risks --project demo --format json', {
        timeoutMs: 30_000,
      });

      // Progress one-liner + spinner labels belong on stderr.
      expect(result.stderr).toContain('Synchronizing settings');
      expect(result.stderr).toContain('Discovering dependency manifests');
      // stdout must stay clean: no progress text leaks into the payload stream.
      expect(result.stdout).not.toContain('Synchronizing settings');
      expect(result.stdout).not.toContain('Discovering dependency manifests');
      expect(result.stdout).not.toContain('Analyzing dependency risks');
    },
    { timeout: 30000 },
  );

  it(
    'auto-installs sca-scanner-cli when binary is absent',
    async () => {
      await harness.newFakeBinariesServer().start();
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withScaEnabled(true)
        .withProject('demo')
        .withProjectSettings('demo', [])
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run('analyze dependency-risks --project demo --format json');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(MANIFEST_DISCOVERY_FAILURE_PREFIX);
      expect(harness.cliHome.file('bin', buildLocalBinaryName(detectPlatform())).exists()).toBe(
        true,
      );
      const state = harness.stateJsonFile.asJson() as {
        dependencies: { installed: Array<{ id: string; version: string }> };
      };
      const recorded = state.dependencies.installed.find((d) => d.id === 'sca-scanner-cli');
      expect(recorded).toBeDefined();
      expect(recorded?.version).toBeDefined();
    },
    { timeout: 30000 },
  );

  it(
    'aborts when sca-scanner-cli download fails',
    async () => {
      await harness.newFakeBinariesServer().noArtifacts().start();
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withScaEnabled(true)
        .withProject('demo')
        .withProjectSettings('demo', [])
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run('analyze dependency-risks --project demo --format json');

      expect(result.exitCode).not.toBe(0);
      expect(harness.cliHome.file('bin', buildLocalBinaryName(detectPlatform())).exists()).toBe(
        false,
      );
    },
    { timeout: 30000 },
  );

  it('rejects an unknown --statuses value', async () => {
    harness.withAuth('http://unused.example', VALID_TOKEN, TEST_ORG);

    const result = await harness.run('analyze dependency-risks --project demo --statuses bogus');
    const output = result.stdout + result.stderr;

    expect(result.exitCode).not.toBe(0);
    expect(output).toContain("Invalid --statuses value: 'bogus'");
    expect(output).toContain(
      'https://docs.sonarsource.com/sonarqube-cli/analysis/sca#filter-by-status',
    );
  });

  it('rejects an unknown --min-severity value', async () => {
    harness.withAuth('http://unused.example', VALID_TOKEN, TEST_ORG);

    const result = await harness.run(
      'analyze dependency-risks --project demo --min-severity bogus',
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "error: option '--min-severity <severity>' argument 'bogus' is invalid. Allowed choices are BLOCKER, HIGH, MEDIUM, LOW, INFO.",
    );
  });

  it('exits with code 1 when the SCA endpoint is absent (404)', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withVersion('26.4')
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN);

    const result = await harness.run('analyze dependency-risks --project demo');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      'Software Composition Analysis is not available for the current connection.',
    );
  });

  it('exits with code 1 when the on-premise server version is below 2026.4', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withVersion('26.3')
      .withScaEnabled(true)
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN);

    const result = await harness.run('analyze dependency-risks --project demo');
    const output = result.stdout + result.stderr;

    expect(result.exitCode).toBe(1);
    expect(output).toContain(
      'Running Software Composition Analysis from this CLI requires SonarQube Server 2026.4 or later (server is 26.3)',
    );
    expect(output).toContain(
      'https://docs.sonarsource.com/sonarqube-cli/analysis/sca#prerequisites',
    );
    // Version check runs before the SCA feature-enabled probe.
    expect(server.getRecordedRequests().some((r) => r.path.endsWith('/sca/feature-enabled'))).toBe(
      false,
    );
  });

  it('proceeds past the version check when the on-premise server version is 2026.4 or newer', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withVersion('2026.4.0.12345')
      .withScaEnabled(false)
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN);

    const result = await harness.run('analyze dependency-risks --project demo');

    // Version check passes — failure now comes from the SCA availability check.
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      'Software Composition Analysis is not available for the current connection.',
    );
  });

  it('exits with code 1 when the on-premise server version cannot be determined', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withSystemStatusCode(503)
      .withScaEnabled(true)
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN);

    const result = await harness.run('analyze dependency-risks --project demo');
    const output = result.stdout + result.stderr;

    expect(result.exitCode).toBe(1);
    expect(output).toContain(
      'Could not determine SonarQube Server version. Running Software Composition Analysis from this CLI requires SonarQube Server 2026.4 or later.',
    );
    expect(output).toContain(
      'https://docs.sonarsource.com/sonarqube-cli/analysis/sca#prerequisites',
    );
  });

  it('skips the server version check for cloud connections', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withVersion('1.0')
      .withScaEnabled(false)
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

    const result = await harness.run('analyze dependency-risks --project demo');

    // Despite the absurdly old "version", the cloud path bypasses the check
    // and proceeds to the SCA availability probe.
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      'Software Composition Analysis is not available for the current connection.',
    );
    expect(server.getRecordedRequests().some((r) => r.path === '/api/system/status')).toBe(false);
  });

  it('auto-detects the project key from sonar-project.properties when --project is omitted', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withScaEnabled(true)
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);
    harness.cwd.writeFile('sonar-project.properties', 'sonar.projectKey=demo\n');

    const result = await harness.run('analyze dependency-risks');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Using auto-detected project key: demo');
  });

  it('exits with code 1 when no project key can be resolved', async () => {
    harness.withAuth('http://unused.example', VALID_TOKEN, TEST_ORG);

    const result = await harness.run('analyze dependency-risks');

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain('Could not determine project key.');
    expect(output).toContain('Use --project <key>');
  });

  it('prefers an explicit --project over auto-detection', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withScaEnabled(true)
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);
    // A different key in the config must not override the explicit flag.
    harness.cwd.writeFile('sonar-project.properties', 'sonar.projectKey=other\n');

    const result = await harness.run('analyze dependency-risks --project demo');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Using project key: demo');
    expect(result.stderr).not.toContain('Using auto-detected project key');
  });
});

describe('analyze dependency-risks — project_uuid telemetry', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'resolves and records a non-null project_uuid on CliCommandExecuted',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withScaEnabled(true)
        .withProject('demo')
        .withProjectSettings('demo', [])
        .start();
      // Deliberately do NOT set TELEMETRY_FLUSH_MODE_ENV here: that flag makes storeEvent()
      // (which owns CliCommandExecuted) no-op, since it also doubles as the guard that stops
      // the detached flush worker from recursively emitting its own CliCommandExecuted event.
      harness.state().withTelemetryEnabled();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      // The scan itself still fails against the fake server (no SCA backend — the manifest
      // discovery/secrets pre-scan step fails first, before the SCA analyzer's own telemetry
      // try/catch is even reached; see sca-scan-orchestrator.ts), but the project key is
      // resolved (and project_uuid recorded on the command) before any of that runs.
      const result = await harness.run('analyze dependency-risks --project demo --format json', {
        timeoutMs: 30_000,
      });

      expect(result.exitCode).toBe(1);
      const [commandEvent] = readCommandEvents(harness.sonarUserHome.path);
      expect(commandEvent.event_payload.command).toBe('analyze');
      expect(commandEvent.event_payload.project_uuid).toBe('AYdemolegacy');
    },
    { timeout: 30000 },
  );

  it(
    'leaves project_uuid null on CliCommandExecuted for commands with no project context',
    async () => {
      harness.state().withTelemetryEnabled();

      const result = await harness.run('system status --json');

      expect(result.exitCode).toBe(0);
      const [commandEvent] = readCommandEvents(harness.sonarUserHome.path);
      expect(commandEvent.event_payload.project_uuid).toBeNull();
    },
    { timeout: 15000 },
  );
});
