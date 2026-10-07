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

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { DetachedAnalysisStatus } from '@/commands/onboard/detached.ts';
import type { OnboardReport } from '@/commands/onboard/output.ts';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { scannerArchive, SONAR_SCANNER_VERSION } from '@/core/host/install/sonar-scanner.ts';
import type { CliState } from '@/core/state/state.ts';

import { IS_WINDOWS, TestHarness } from '../../harness';

const TOKEN = 'detached-test-token';

describe('sonar onboard --detach', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    const bin = join(harness.userHome.path, 'path-bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, IS_WINDOWS ? 'sonar-scanner.bat' : 'sonar-scanner'),
      IS_WINDOWS ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n',
      { mode: 0o755 },
    );
    harness.withExtraEnv({ PATH: bin + delimiter + (process.env.PATH ?? '') });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function seedScanner(): void {
    const home = join(harness.cliHome.path, 'bin', scannerArchive(detectPlatform()).directoryName);
    const java = join(home, 'jre', 'bin', IS_WINDOWS ? 'java.exe' : 'java');
    mkdirSync(dirname(java), { recursive: true });
    mkdirSync(join(home, 'lib'), { recursive: true });
    copyFileSync(
      join(
        import.meta.dir,
        '../../resources',
        IS_WINDOWS ? 'sonar-scanner-stub.exe' : 'sonar-scanner-stub',
      ),
      java,
    );
    if (!IS_WINDOWS) chmodSync(java, 0o755);
    writeFileSync(join(home, 'lib', `sonar-scanner-cli-${SONAR_SCANNER_VERSION}.jar`), '');
    harness.withExtraEnv({
      ONBOARD_STUB_LOG_PATH: harness.cliHome.file('scanner-invocations.jsonl').path,
    });
  }

  async function waitForStatus(path: string): Promise<DetachedAnalysisStatus> {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (existsSync(path)) {
        const status = JSON.parse(readFileSync(path, 'utf8')) as DetachedAnalysisStatus;
        if (status.status === 'completed' || status.status === 'failed') return status;
      }
      await Bun.sleep(25);
    }
    throw new Error('The detached analysis did not finish.');
  }

  it('returns before the scan finishes and keeps work files alive until the worker completes', async () => {
    const server = await harness.newFakeServer().withAuthToken(TOKEN).start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    harness.cwd.writeFile('service/app.js', '');
    harness.withExtraEnv({
      ONBOARD_STUB_SLEEP_MS: '3000',
      ONBOARD_STUB_STDOUT: TOKEN,
      SONAR_HTTP_PROXY_URL: 'http://127.0.0.1:1',
      SONAR_NO_PROXY: 'localhost',
      SONAR_SCANNER_PROXY_HOST: 'stale-proxy',
      SONAR_SCANNER_PROXY_PORT: 'invalid',
    });
    const result = await harness.run(
      'onboard --detach --path service --name "Background Service" --visibility public --format json',
    );
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as OnboardReport;
    expect(report.analysis.status).toBe('detached');
    if (report.analysis.status !== 'detached') throw new Error('Expected a detached report.');
    expect(report.analysis.pid).toBeGreaterThan(0);
    expect(report.analysis.id).toBeNull();
    expect(report.qualityGate).toBeNull();
    expect(report.issues).toBeNull();
    expect(report.projectName).toBe('Background Service');
    expect(report.scannerLogPath).not.toBeNull();
    expect(existsSync(report.analysis.statusPath)).toBe(true);
    expect(JSON.parse(readFileSync(report.analysis.statusPath, 'utf8')).status).toBe('running');
    expect(server.getRecordedRequests().some((r) => r.path === '/api/ce/task')).toBe(false);
    const tmpRoot = join(harness.cliHome.path, 'cli-tmp');
    expect(readdirSync(tmpRoot).some((p) => p.startsWith('onboard-'))).toBe(true);
    const state = harness.stateJsonFile.asJson() as CliState;
    state.auth.connections = [];
    state.auth.isAuthenticated = false;
    writeFileSync(harness.stateJsonFile.path, JSON.stringify(state));
    writeFileSync(harness.keychainJsonFile, '{}');
    const status = await waitForStatus(report.analysis.statusPath);
    expect(status.status).toBe('completed');
    expect(status.projectKey).toBe(report.projectKey);
    expect(status.analysisId).toBe('onboard-analysis');
    expect(status.qualityGate).toBe('OK');
    expect(readFileSync(report.scannerLogPath!, 'utf8')).toContain('[REDACTED]');
    expect(readFileSync(report.scannerLogPath!, 'utf8')).not.toContain(TOKEN);
    expect(readFileSync(report.analysis.statusPath, 'utf8')).not.toContain(TOKEN);
    expect(readdirSync(tmpRoot).filter((p) => p.startsWith('onboard-'))).toHaveLength(0);
    const invocation = JSON.parse(
      harness.cliHome.file('scanner-invocations.jsonl').asText().trim(),
    );
    expect(invocation.cwd).toBe(join(harness.cwd.path, 'service'));
    expect(invocation.args).toContain('-Dsonar.projectName=Background Service');
    expect(invocation.args.join(' ')).not.toContain(TOKEN);
    expect(invocation.network.proxyHost).toBeUndefined();
    expect(invocation.network.proxyPort).toBeUndefined();
  }, 15000);

  it('preserves temporary TLS stores until the detached scanner is finished', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    harness.withExtraEnv({
      ONBOARD_STUB_SLEEP_MS: '2000',
      SONAR_CA_CERT: join(import.meta.dir, '../../../fixtures/client-cert/client-cert.pem'),
      SONAR_TLS_CLIENT_CERT: join(
        import.meta.dir,
        '../../../fixtures/client-cert/client-cert-no-passphrase.p12',
      ),
    });
    const result = await harness.run('onboard --detach --project-key tls-job --format json');
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as OnboardReport;
    if (report.analysis.status !== 'detached') throw new Error('Expected a detached report.');
    const tmpRoot = join(harness.cliHome.path, 'cli-tmp');
    const directoryName = readdirSync(tmpRoot).find((p) => p.startsWith('onboard-'));
    if (!directoryName) throw new Error('Expected a live working directory.');
    const truststore = join(tmpRoot, directoryName, 'truststore.p12');
    expect(existsSync(truststore)).toBe(true);
    expect((await waitForStatus(report.analysis.statusPath)).status).toBe('completed');
    expect(existsSync(truststore)).toBe(false);
    const invocation = JSON.parse(
      harness.cliHome.file('scanner-invocations.jsonl').asText().trim(),
    );
    expect(invocation.network.truststore).toBe(truststore);
    expect(invocation.network.keystore).toContain('client-cert-no-passphrase.p12');
  }, 15000);

  it('starts a detached worker when running the CLI from TypeScript source', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const entry = join(import.meta.dir, '../../../../src/index.ts');
    const result = await harness.run(
      `"${entry}" onboard --detach --project-key source-job --format json`,
      {
        binaryPath: process.execPath,
        timeoutMs: 15000,
      },
    );
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as OnboardReport;
    if (report.analysis.status !== 'detached') throw new Error('Expected a detached report.');
    expect((await waitForStatus(report.analysis.statusPath)).status).toBe('completed');
  }, 20000);

  it('reports scanner failure in a status file and cleans up the background workspace', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    harness.withExtraEnv({ ONBOARD_STUB_EXIT_CODE: '1', ONBOARD_STUB_STDERR: TOKEN });
    const result = await harness.run('onboard --detach --project-key failed-scan --format json');
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as OnboardReport;
    if (report.analysis.status !== 'detached') throw new Error('Expected a detached report.');
    const status = await waitForStatus(report.analysis.statusPath);
    expect(status.status).toBe('failed');
    expect(status.error).toContain('SonarScanner exited with code 1');
    expect(readFileSync(report.scannerLogPath!, 'utf8')).not.toContain(TOKEN);
    expect(readdirSync(join(harness.cliHome.path, 'cli-tmp'))).toHaveLength(0);
  }, 15000);

  it('reports server processing failure after the parent has returned', async () => {
    const server = await harness
      .newFakeServer()
      .withOnboarding({ taskStatuses: ['FAILED'] })
      .start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const result = await harness.run(
      'onboard --detach --project-key processing-failure --format json',
    );
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as OnboardReport;
    if (report.analysis.status !== 'detached') throw new Error('Expected a detached report.');
    const status = await waitForStatus(report.analysis.statusPath);
    expect(status.status).toBe('failed');
    expect(status.error).toContain('Analysis processing failed');
  }, 15000);

  it('prints the background PID, status, log and dashboard in text output', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const result = await harness.run('onboard --detach --project-key text-job --format text');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Analysis running in background (PID');
    expect(result.stdout).toContain('Scanner log:');
    expect(result.stdout).toContain('Analysis status:');
    expect(result.stdout).not.toContain('Analysis complete');
    const statusName = readdirSync(join(harness.cliHome.path, 'logs')).find((p) =>
      /^sonar-onboard-.*\.json$/.test(p),
    );
    if (!statusName) throw new Error('Expected a background status file.');
    expect((await waitForStatus(join(harness.cliHome.path, 'logs', statusName))).status).toBe(
      'completed',
    );
  }, 15000);

  it('rejects detach combined with verbose before creating the project', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    const result = await harness.run('onboard --project-key invalid-job --detach --verbose');
    expect(result.exitCode).toBe(2);
    expect(result.stdout + result.stderr).toContain('--detach cannot be combined with --verbose');
    expect(server.getRecordedRequests().some((r) => r.path === '/api/projects/create')).toBe(false);
  });

  it('does not launch a worker for an existing project', async () => {
    const server = await harness.newFakeServer().withProject('existing-project').start();
    harness.withAuth(server.baseUrl(), TOKEN);
    const result = await harness.run(
      'onboard --project-key existing-project --detach --format json',
    );
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as OnboardReport;
    expect(report.analysis.status).toBe('skipped');
    expect(report.scannerLogPath).toBeNull();
    expect(harness.cliHome.file('cli-tmp').exists()).toBe(false);
  });
});
