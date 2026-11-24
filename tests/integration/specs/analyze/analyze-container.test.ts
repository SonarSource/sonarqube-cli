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

import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { buildLocalBinaryName, resolveBinaryArtifact } from '@/core/host/install/binary.ts';
import { CONTAINER_SCANNER_SPEC } from '@/core/host/install/container-scanner.ts';

import { readAnalysisEvents, readCommandEvents } from '../../../_common/telemetry-helpers.ts';
import { TestHarness } from '../../harness';
import {
  CONTAINER_SCANNER_INVOCATIONS_FILE,
  installRecordingStub,
  readContainerScannerInvocations,
  type StubResponse,
} from '../../harness/recording-stub.ts';

const TOKEN = 'container-test-token';
const ORGANIZATION = 'container-test-org';
const IMAGE = './my-image.tar';
const configuration = {
  imageInput: IMAGE,
  failOn: 'high',
  timeoutSecs: 300,
  registry: null,
  repository: null,
  tag: null,
};
const findings = [
  { severity: 'medium', packageName: 'example', version: '1.0', vulnerabilityId: 'CVE-2025-0001' },
  { severity: 'high', packageName: 'example', version: '1.0', key: 'CVE-2025-0002' },
];
const binaryName = buildLocalBinaryName(CONTAINER_SCANNER_SPEC, detectPlatform());

function installStub(harness: TestHarness, response: StubResponse, captureEnv?: string[]): void {
  installRecordingStub(harness.cliHome.file('bin', binaryName).path, {
    invocationsFile: harness.cliHome.file(CONTAINER_SCANNER_INVOCATIONS_FILE).path,
    captureEnv,
    fallback: response,
  });
}

describe('analyze container', () => {
  let harness: TestHarness;
  let cloudUrl: string;

  beforeEach(async () => {
    harness = await TestHarness.create();
    const cloud = await harness.newFakeServer().withAuthToken(TOKEN).start();
    cloudUrl = cloud.baseUrl();
    harness.withAuth(cloudUrl, TOKEN, ORGANIZATION);
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('installs the signed scanner on first use, keeps JSON stdout clean, and reuses its cache', async () => {
    const binaries = await harness.newFakeBinariesServer().start();
    const result = await harness.run('analyze container ./missing-image.tar');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Installing sonar-container-scanner');
    expect(JSON.parse(result.stdout)).toMatchObject({
      issues: [],
      configuration: { imageInput: './missing-image.tar', failOn: 'high', timeoutSecs: 300 },
      exitCode: 1,
    });
    expect(harness.cliHome.file('bin', binaryName).exists()).toBeTrue();

    const second = await harness.run('analyze container ./missing-image.tar');
    expect(second.exitCode).toBe(1);
    expect(second.stderr).not.toContain('Installing sonar-container-scanner');
    expect(JSON.parse(second.stdout)).toMatchObject({ exitCode: 1 });
    const artifact = resolveBinaryArtifact(CONTAINER_SCANNER_SPEC, detectPlatform());
    expect(binaries.getRecordedRequests().map(({ path }) => path)).toEqual([
      new URL(artifact.url).pathname,
    ]);
  }, 30_000);

  it('uses CI authentication and default JSON outside Git, including when the threshold is disabled', async () => {
    const report = {
      issues: findings,
      errors: [],
      configuration: { ...configuration, failOn: 'none' },
      exitCode: 0,
    };
    installStub(harness, { stdout: JSON.stringify(report), exitCode: 0 }, [
      'SONAR_CONTAINER_SCANNER_TOKEN',
      'SONAR_CONTAINER_SCANNER_ORG',
      'SONAR_HOST_URL',
    ]);
    const result = await harness.run('analyze container ./my-image.tar --fail-on none', {
      extraEnv: {
        SONARQUBE_CLI_TOKEN: 'ci-test-token',
        SONARQUBE_CLI_ORG: 'ci-test-org',
        SONARQUBE_CLI_SERVER: 'https://sonarqube.us',
        SONARQUBE_CLI_SONARCLOUD_US_URL: cloudUrl,
        SONARQUBE_CLI_SONARCLOUD_US_API_URL: cloudUrl,
      },
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(report);
    expect(readAnalysisEvents(harness.sonarUserHome.path)).toEqual([]);
    expect(readContainerScannerInvocations(harness)).toEqual([
      {
        argv: [
          '--format',
          'json',
          '--skip-update-check',
          '--timeout-secs=300',
          '--fail-on=none',
          '--',
          IMAGE,
        ],
        env: {
          SONAR_CONTAINER_SCANNER_TOKEN: 'ci-test-token',
          SONAR_CONTAINER_SCANNER_ORG: 'ci-test-org',
          SONAR_HOST_URL: 'https://sonarqube.us',
        },
      },
    ]);
  });

  it('passes the active connection and the requested options, clears inherited overrides, and renders a table', async () => {
    installStub(
      harness,
      {
        stdout: JSON.stringify({ issues: findings, errors: [], configuration, exitCode: 1 }),
        stderr: 'WARNING: the backend skipped 1 package(s)',
        exitCode: 1,
      },
      [
        'SONAR_CONTAINER_SCANNER_ORG',
        'SONAR_CONTAINER_SCANNER_TOKEN',
        'SONAR_HOST_URL',
        'SONAR_SCANNER_API_BASE_URL',
        'sonar_scanner_api_base_url',
        'SONAR_HTTPS_PROXY_URL',
        'SONAR_NO_PROXY',
      ],
    );

    const result = await harness.run(
      'analyze container ./my-image.tar --container-engine podman --registry docker.io --repository library/alpine --tag test --timeout-secs 42 --format table',
      {
        extraEnv: {
          SONAR_HOST_URL: 'https://unexpected.example',
          SONAR_CONTAINER_SCANNER_ORG: 'unexpected-org',
          SONAR_CONTAINER_SCANNER_TOKEN: 'unexpected-token',
          SONAR_SCANNER_API_BASE_URL: 'https://unexpected.example',
          sonar_scanner_api_base_url: 'https://unexpected.example',
          SONAR_HTTPS_PROXY_URL: 'http://proxy.example:8888',
          SONAR_NO_PROXY: '127.0.0.1,localhost',
        },
      },
    );

    expect(result.exitCode).toBe(51);
    expect(result.stdout).toContain('example@1.0 (2 findings)');
    expect(result.stdout).toContain('CVE-2025-0001');
    expect(result.stdout).toContain('CVE-2025-0002');
    expect(result.stdout).toContain('1 finding reached the threshold');
    expect(result.stderr).toContain('WARNING: the backend skipped 1 package(s)');
    expect(readContainerScannerInvocations(harness)).toEqual([
      {
        argv: [
          '--format',
          'json',
          '--skip-update-check',
          '--container-engine=podman',
          '--registry=docker.io',
          '--repository=library/alpine',
          '--tag=test',
          '--timeout-secs=42',
          '--fail-on=high',
          '--',
          IMAGE,
        ],
        env: {
          SONAR_CONTAINER_SCANNER_ORG: ORGANIZATION,
          SONAR_CONTAINER_SCANNER_TOKEN: TOKEN,
          SONAR_HOST_URL: cloudUrl,
          SONAR_HTTPS_PROXY_URL: 'http://proxy.example:8888',
          SONAR_NO_PROXY: '127.0.0.1,localhost',
        },
      },
    ]);
  });

  it('strips terminal controls from the table and diagnostics while preserving escaped JSON', async () => {
    const colorControl = '\u001b[31m';
    const controls = colorControl + '\u0007\u009b\u202e';
    const splitToken = TOKEN[0] + colorControl + TOKEN.slice(1);
    const report = {
      issues: [
        { ...findings[1], packageName: 'example' + controls, key: 'CVE-2025-0002' + controls },
      ],
      errors: [],
      configuration,
      exitCode: 1,
    };
    installStub(harness, {
      stdout: JSON.stringify(report),
      stderr: 'Scanner warning' + controls + '\r\nAnother line ' + splitToken,
      exitCode: 1,
    });

    const table = await harness.run('analyze container ./my-image.tar --format table');
    expect(table.exitCode).toBe(51);
    expect(table.stdout).toContain('example@1.0 (1 finding)');
    expect(table.stdout).toContain('CVE-2025-0002');
    expect(table.stderr).toContain('Scanner warning\nAnother line [redacted]');
    expect(table.stderr).not.toContain(TOKEN);
    expect(table.stdout + table.stderr).not.toContain('\u001b');
    expect(table.stdout + table.stderr).not.toContain('\u0007');
    expect(table.stdout + table.stderr).not.toContain('\u009b');
    expect(table.stdout + table.stderr).not.toContain('\u202e');

    const json = await harness.run('analyze container ./my-image.tar');
    expect(JSON.parse(json.stdout)).toEqual({ ...report, exitCode: 51 });
    expect(json.stdout).toContain('\\u001b[31m\\u0007\\u009b\\u202e');

    const errors = [{ kind: 'submission', message: 'Scan failed' + controls }];
    installStub(harness, {
      stdout: JSON.stringify({ issues: [], errors, configuration, exitCode: 2 }),
      exitCode: 2,
    });
    const failure = await harness.run('analyze container ./my-image.tar');
    expect(failure.exitCode).toBe(1);
    expect(failure.stderr).toContain('Scan failed');
    expect(failure.stderr).not.toContain('\u001b');
    expect(failure.stderr).not.toContain('\u0007');
    expect(JSON.parse(failure.stdout)).toMatchObject({ errors, exitCode: 1 });
  });

  it('fails closed on malformed scanner output and redacts the token from diagnostics', async () => {
    installStub(harness, { stdout: '[', stderr: 'Native diagnostics: ' + TOKEN, exitCode: 0 });
    const result = await harness.run('analyze container ./my-image.tar');
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      issues: [],
      errors: [{ kind: 'invalidScannerReport' }],
      exitCode: 1,
    });
    expect(result.stderr).toContain('Native diagnostics: [redacted]');
    expect(result.stderr).not.toContain(TOKEN);
  });

  it.each([
    {
      title: 'threshold hit with partial results',
      nativeExit: 1,
      stdout: JSON.stringify({
        issues: findings,
        errors: [{ kind: 'backendAnalysis', message: 'Sensitive package detail' }],
        configuration,
        exitCode: 1,
      }),
      cliExit: 51,
      observedFindings: 2,
      errors: 1,
      failures: 0,
    },
    {
      title: 'malformed output',
      nativeExit: 0,
      stdout: '[',
      cliExit: 1,
      observedFindings: 0,
      errors: 0,
      failures: 1,
    },
  ])('records one correlated analysis fact for $title', async (test) => {
    harness.state().withTelemetryEnabled();
    installStub(harness, { stdout: test.stdout, exitCode: test.nativeExit });
    const result = await harness.run('analyze container ./my-image.tar');
    expect(result.exitCode).toBe(test.cliExit);
    const analysis = readAnalysisEvents(harness.sonarUserHome.path);
    const commands = readCommandEvents(harness.sonarUserHome.path);
    expect(analysis).toHaveLength(1);
    expect(commands).toHaveLength(1);
    expect(commands[0].event_payload).toMatchObject({
      command: 'analyze',
      subcommand: 'container',
    });
    expect(analysis[0].event_payload).toMatchObject({
      analyzer: 'sonar-container-scanner',
      caller_command: 'analyze container',
      findings_count: test.observedFindings,
      errors_count: test.errors,
      failures_count: test.failures,
      exit_code: test.cliExit,
      invocation_id: commands[0].event_payload.invocation_id,
      details: '',
    });
    expect(analysis[0].event_payload.scan_duration_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify([analysis, commands])).not.toMatch(
      /my-image|CVE-2025|Sensitive package detail/,
    );
  });

  it.each(['0', '1.5', '2s'])(
    'rejects malformed timeout %s before attempting to install',
    async (timeout) => {
      const result = await harness.run(
        ['analyze container ./my-image.tar --timeout-secs', timeout].join(' '),
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Expected a positive integer');
      expect(harness.cliHome.file('bin', binaryName).exists()).toBeFalse();
    },
  );

  it('rejects a Server connection and a Cloud connection without an organization before installing', async () => {
    harness.state().withTelemetryEnabled();
    harness.withAuth(cloudUrl, TOKEN);
    const serverResult = await harness.run('analyze container ./my-image.tar');
    expect(serverResult.exitCode).toBe(1);
    expect(serverResult.stderr).toContain('available only on SonarQube Cloud');

    const noOrg = await harness.run('analyze container ./my-image.tar', {
      extraEnv: {
        SONARQUBE_CLI_TOKEN: TOKEN,
        SONARQUBE_CLI_SERVER: cloudUrl,
        SONARQUBE_CLI_SONARCLOUD_URL: cloudUrl,
      },
    });
    expect(noOrg.exitCode).toBe(1);
    expect(noOrg.stderr).toContain('Could not determine the SonarQube Cloud organization');
    expect(harness.cliHome.file('bin', binaryName).exists()).toBeFalse();
    expect(readAnalysisEvents(harness.sonarUserHome.path)).toEqual([]);
    expect(readCommandEvents(harness.sonarUserHome.path)).toHaveLength(2);
  });
});
