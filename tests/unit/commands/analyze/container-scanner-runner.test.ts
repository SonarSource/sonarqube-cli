/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

import { rejects } from 'node:assert/strict';
import * as fs from 'node:fs';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

import {
  type ContainerScanOptions,
  prepareContainerScannerEnv,
  runContainerScanner,
} from '@/commands/analyze/container-scanner-runner.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import * as configRepository from '@/core/config/config-repository.ts';
import * as network from '@/core/host/connectivity/network-config.ts';
import * as subprocess from '@/core/process/process.ts';

const AUTH = new ResolvedAuth({
  serverUrl: 'https://sonarqube.us',
  token: 'resolved-token',
  orgKey: 'resolved-org',
  connectionType: 'cloud',
  source: 'env',
});
const SCAN_RESULT = { exitCode: 1, stdout: '{}', stderr: 'Some packages could not be scanned' };
const DEFAULT_OPTIONS: ContainerScanOptions = { timeoutSecs: 5, failOn: 'high' };
const WATCHDOG_MSG = 'The container scanner did not exit after its scan timeout.';
const SIGNALS =
  process.platform === 'win32'
    ? (['SIGINT', 'SIGTERM'] as const)
    : (['SIGINT', 'SIGTERM', 'SIGHUP'] as const);

const upperKeys = (env: NodeJS.ProcessEnv) => Object.keys(env).map((key) => key.toUpperCase());
const listenerCounts = () => SIGNALS.map((signal) => process.listenerCount(signal));
const runScanner = (
  env: NodeJS.ProcessEnv = {},
  options: ContainerScanOptions = DEFAULT_OPTIONS,
  image = 'alpine:3.20',
) => runContainerScanner('sonar-container-scanner', image, options, env);

function prepareWithResolvedNetwork(baseEnv: NodeJS.ProcessEnv) {
  spyOn(configRepository, 'getConfigValue').mockResolvedValue(undefined);
  spyOn(network, 'getNetworkConfig').mockImplementation(() =>
    network.resolveNetworkConfig(baseEnv),
  );
  return prepareContainerScannerEnv(AUTH, baseEnv);
}

afterEach(() => mock.restore());

describe('prepareContainerScannerEnv', () => {
  it('uses the active Cloud connection, resolved network config, and strips managed vars', async () => {
    const subprocessEnv = spyOn(network, 'buildSubprocessNetworkEnv').mockResolvedValue({
      SONAR_HTTPS_PROXY_URL: 'http://resolved-proxy.example:8080',
      SONAR_NO_PROXY: 'localhost',
    });
    const env = await prepareContainerScannerEnv(AUTH, {
      sonar_scanner_api_base_url: 'https://inherited-endpoint.example',
      SONARQUBE_CLI_TOKEN: 'inherited-token',
      SONAR_CONTAINER_SCANNER_TOKEN: 'inherited-scanner-token',
      SONAR_CONTAINER_SCANNER_SKIP_UPDATE_CHECK: 'false',
      sonar_container_scanner_skip_update_check: '0',
      sonar_https_proxy_url: 'http://inherited-proxy.example:8080',
      CONTAINER_SCANNER_TEST_ENV: 'preserved',
    });

    expect(subprocessEnv).toHaveBeenCalledWith(undefined, { includeClientCert: false });
    expect(env).toEqual({
      CONTAINER_SCANNER_TEST_ENV: 'preserved',
      SONAR_HTTPS_PROXY_URL: 'http://resolved-proxy.example:8080',
      SONAR_NO_PROXY: 'localhost',
      SONAR_CONTAINER_SCANNER_ORG: 'resolved-org',
      SONAR_CONTAINER_SCANNER_TOKEN: 'resolved-token',
      SONAR_HOST_URL: 'https://sonarqube.us',
    });
  });

  it('ignores Server mTLS cert errors and strips client-cert and standalone SONAR_NO_PROXY vars', async () => {
    const getNetworkConfigOrThrow = spyOn(network, 'getNetworkConfigOrThrow');
    spyOn(network, 'getNetworkConfig').mockResolvedValue({
      proxy: null,
      caCert: { path: '/etc/ssl/corp-ca.pem', source: 'sonar-env', explicit: true },
      clientCert: {
        certPath: '/etc/ssl/client.pem',
        keyPath: '/etc/ssl/client-key.pem',
        passphrase: 'test-passphrase-placeholder',
        source: 'sonar-env',
        explicit: true,
        format: 'pem',
        resolvedCertPem: 'CERT',
        resolvedKeyPem: 'KEY',
      },
      error: 'Client certificate file could not be read',
    });

    const env = await prepareContainerScannerEnv(AUTH, {
      SONAR_NO_PROXY: 'internal.corp.example',
      sonar_no_proxy: 'lowercase.corp.example',
      SONAR_TLS_CLIENT_CERT: '/etc/ssl/client.pem',
      SONAR_TLS_CLIENT_KEY_FILE: '/etc/ssl/client-key.pem',
      SONAR_TLS_CLIENT_PASSPHRASE: 'test-passphrase-placeholder',
      sonar_tls_client_passphrase: 'lowercase-passphrase-placeholder',
      KEEP_ME: 'yes',
    });

    expect(getNetworkConfigOrThrow).not.toHaveBeenCalled();
    expect(env.SONAR_CA_CERT).toBe('/etc/ssl/corp-ca.pem');
    expect(env.KEEP_ME).toBe('yes');
    for (const key of [
      'SONAR_NO_PROXY',
      'SONAR_TLS_CLIENT_CERT',
      'SONAR_TLS_CLIENT_KEY_FILE',
      'SONAR_TLS_CLIENT_PASSPHRASE',
    ]) {
      expect(upperKeys(env)).not.toContain(key);
    }
  });

  it('enforces CLI atomic proxy tiers while stripping generic proxy vars (including ALL_PROXY)', async () => {
    const httpOnlyEnv = await prepareWithResolvedNetwork({
      SONAR_HTTP_PROXY_URL: 'http://sonar-http.example:8080',
      HTTPS_PROXY: 'http://inherited-https.example:3128',
      https_proxy: 'http://inherited-lower-https.example:3128',
      HTTP_PROXY: 'http://inherited-http.example:3128',
      NO_PROXY: 'inherited.corp.example',
      ALL_PROXY: 'socks5://proxy.example:1080',
      all_proxy: 'socks5://lower-proxy.example:1080',
      KEEP_ME: 'yes',
    });
    expect(httpOnlyEnv.SONAR_HTTP_PROXY_URL).toBe('http://sonar-http.example:8080');
    expect(httpOnlyEnv.SONAR_HTTPS_PROXY_URL).toBeUndefined();
    expect(httpOnlyEnv.SONAR_NO_PROXY).toBeUndefined();
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY']) {
      expect(upperKeys(httpOnlyEnv)).not.toContain(key);
    }

    const genericEnv = await prepareWithResolvedNetwork({
      HTTPS_PROXY: 'http://generic-https.example:3128',
      HTTP_PROXY: 'http://generic-http.example:3128',
      NO_PROXY: 'localhost,internal.example',
      all_proxy: 'socks5://ignored.example:1080',
    });
    expect(genericEnv.SONAR_HTTPS_PROXY_URL).toBe('http://generic-https.example:3128');
    expect(genericEnv.SONAR_HTTP_PROXY_URL).toBe('http://generic-http.example:3128');
    expect(genericEnv.SONAR_NO_PROXY).toBe('localhost,internal.example');
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY']) {
      expect(upperKeys(genericEnv)).not.toContain(key);
    }
  });

  it('rejects a Server connection and diagnoses a missing organization on a Cloud URL', async () => {
    const serverAuth = new ResolvedAuth({
      token: 'server-token',
      serverUrl: 'https://sonarqube.example',
      connectionType: 'on-premise',
      source: 'env',
    });
    const missingOrg = new ResolvedAuth({ ...serverAuth, serverUrl: 'https://sonarqube.us' });
    const buildNetworkEnv = spyOn(network, 'buildSubprocessNetworkEnv');

    await rejects(prepareContainerScannerEnv(serverAuth), /only on SonarQube Cloud/);
    await rejects(
      prepareContainerScannerEnv(missingOrg),
      /Could not determine the SonarQube Cloud organization/,
    );
    expect(buildNetworkEnv).not.toHaveBeenCalled();
  });
});

describe('runContainerScanner', () => {
  it('passes options, literal image, isolated env, killProcessTree, and clamps watchdog timeout', async () => {
    const spawn = spyOn(subprocess, 'spawnProcessWithTimeout').mockResolvedValue(SCAN_RESULT);

    const result = await runScanner(
      { SONAR_CONTAINER_SCANNER_TOKEN: 'resolved-token' },
      {
        containerEngine: 'podman',
        registry: 'registry.example',
        repository: 'my-app',
        tag: '1.2.3',
        timeoutSecs: 5,
        failOn: 'medium',
      },
      '--licenses',
    );
    expect(result).toEqual(SCAN_RESULT);
    expect(spawn).toHaveBeenLastCalledWith(
      'sonar-container-scanner',
      [
        '--format',
        'json',
        '--skip-update-check',
        '--container-engine=podman',
        '--registry=registry.example',
        '--repository=my-app',
        '--tag=1.2.3',
        '--timeout-secs=5',
        '--fail-on=medium',
        '--',
        '--licenses',
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          SONAR_CONTAINER_SCANNER_TOKEN: 'resolved-token',
          TMPDIR: expect.any(String),
        }),
        isolateEnv: true,
        killProcessTree: true,
      }),
      45_000,
      WATCHDOG_MSG,
    );

    await runScanner({}, { timeoutSecs: 10_000_000, failOn: 'high' });
    expect(spawn).toHaveBeenLastCalledWith(
      'sonar-container-scanner',
      [
        '--format',
        'json',
        '--skip-update-check',
        '--timeout-secs=10000000',
        '--fail-on=high',
        '--',
        'alpine:3.20',
      ],
      expect.objectContaining({ isolateEnv: true, killProcessTree: true }),
      2_147_483_647,
      WATCHDOG_MSG,
    );
  });

  it.each(
    SIGNALS.map((signal) => ({
      signal,
      expectedExitCode: signal === 'SIGHUP' ? 129 : signal === 'SIGINT' ? 130 : 143,
    })),
  )(
    'aborts the child signal, exits with $expectedExitCode on $signal, and cleans up listeners',
    async ({ signal, expectedExitCode }) => {
      const before = listenerCounts();
      spyOn(subprocess, 'spawnProcessWithTimeout').mockImplementationOnce((_, __, options) => {
        expect(options.signal?.aborted).toBe(false);
        process.listeners(signal).at(-1)?.(signal);
        expect(options.signal?.aborted).toBe(true);
        return Promise.resolve(SCAN_RESULT);
      });

      const error = await runScanner().catch((err: unknown) => err);
      expect(error).toBeInstanceOf(CommandFailedError);
      expect((error as CommandFailedError).message).toBe('Container scan cancelled.');
      expect((error as CommandFailedError).exitCode).toBe(expectedExitCode);
      expect(listenerCounts()).toEqual(before);
    },
  );

  it('prefers cancellation on concurrent rejection and restores listeners on normal rejection', async () => {
    const before = listenerCounts();
    spyOn(subprocess, 'spawnProcessWithTimeout').mockImplementationOnce(() => {
      process.listeners('SIGINT').at(-1)?.('SIGINT');
      return Promise.reject(new subprocess.ProcessTimedOutError('timed out'));
    });
    const cancelled = await runScanner().catch((err: unknown) => err);
    expect(cancelled).toBeInstanceOf(CommandFailedError);
    expect((cancelled as CommandFailedError).exitCode).toBe(130);
    expect(listenerCounts()).toEqual(before);

    const timeoutError = new subprocess.ProcessTimedOutError('hung');
    spyOn(subprocess, 'spawnProcessWithTimeout').mockRejectedValueOnce(timeoutError);
    expect(await runScanner().catch((err: unknown) => err)).toBe(timeoutError);
    expect(listenerCounts()).toEqual(before);
  });

  it('creates a per-run scratch temp dir under inherited root, strips case variants, and removes it on success, failure, and abort', async () => {
    const inheritedRoot = mkdtempSync(join(tmpdir(), 'container-runner-root-'));
    try {
      let scratchDir = '';
      let capturedEnv: NodeJS.ProcessEnv = {};
      spyOn(subprocess, 'spawnProcessWithTimeout').mockImplementationOnce((_, __, options) => {
        capturedEnv = options.env ?? {};
        scratchDir = capturedEnv.TMPDIR ?? '';
        expect(dirname(scratchDir)).toBe(inheritedRoot);
        expect(existsSync(scratchDir)).toBe(true);
        writeFileSync(join(scratchDir, 'layer.tar'), 'data');
        return Promise.resolve(SCAN_RESULT);
      });
      expect(
        await runScanner({ TMPDIR: inheritedRoot, tmpdir: '/lowercase/old', KEEP_ME: 'yes' }),
      ).toEqual(SCAN_RESULT);
      expect(capturedEnv.KEEP_ME).toBe('yes');
      expect(Object.keys(capturedEnv).filter((k) => k.toUpperCase() === 'TMPDIR')).toEqual([
        'TMPDIR',
      ]);
      expect(existsSync(scratchDir)).toBe(false);

      const timeoutError = new subprocess.ProcessTimedOutError('hung');
      spyOn(subprocess, 'spawnProcessWithTimeout').mockImplementationOnce((_, __, options) => {
        scratchDir = options.env?.TMPDIR ?? '';
        writeFileSync(join(scratchDir, 'partial.tar'), 'data');
        return Promise.reject(timeoutError);
      });
      expect(await runScanner().catch((err: unknown) => err)).toBe(timeoutError);
      expect(existsSync(scratchDir)).toBe(false);

      spyOn(subprocess, 'spawnProcessWithTimeout').mockImplementationOnce((_, __, options) => {
        scratchDir = options.env?.TMPDIR ?? '';
        process.listeners('SIGINT').at(-1)?.('SIGINT');
        return Promise.resolve(SCAN_RESULT);
      });
      await runScanner().catch(() => undefined);
      expect(existsSync(scratchDir)).toBe(false);
    } finally {
      rmSync(inheritedRoot, { recursive: true, force: true });
    }
  });

  it('does not mask scan outcomes if scratch temp dir cleanup fails', async () => {
    let scratchDir = '';
    spyOn(subprocess, 'spawnProcessWithTimeout').mockImplementationOnce((_, __, options) => {
      scratchDir = options.env?.TMPDIR ?? '';
      return Promise.resolve(SCAN_RESULT);
    });
    const rmSpy = spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('EBUSY: file locked');
    });
    try {
      expect(await runScanner()).toEqual(SCAN_RESULT);
      expect(rmSpy).toHaveBeenCalledWith(scratchDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    } finally {
      rmSpy.mockRestore();
      if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
