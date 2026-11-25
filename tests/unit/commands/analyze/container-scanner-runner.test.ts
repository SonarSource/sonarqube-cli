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

afterEach(() => mock.restore());

describe('prepareContainerScannerEnv', () => {
  it('uses the active Cloud connection and resolved network configuration', async () => {
    const subprocessEnv = spyOn(network, 'buildSubprocessNetworkEnv').mockResolvedValue({
      SONAR_HTTPS_PROXY_URL: 'http://resolved-proxy.example:8080',
      SONAR_NO_PROXY: 'localhost',
    });
    const baseEnv: NodeJS.ProcessEnv = {
      sonar_scanner_api_base_url: 'https://inherited-endpoint.example',
      SONARQUBE_CLI_TOKEN: 'inherited-token',
      SONAR_CONTAINER_SCANNER_TOKEN: 'inherited-scanner-token',
      sonar_https_proxy_url: 'http://inherited-proxy.example:8080',
      CONTAINER_SCANNER_TEST_ENV: 'preserved',
    };

    const env = await prepareContainerScannerEnv(AUTH, baseEnv);

    expect(subprocessEnv).toHaveBeenCalledWith(undefined, { includeClientCert: false });
    expect({
      SONAR_CONTAINER_SCANNER_ORG: env.SONAR_CONTAINER_SCANNER_ORG,
      SONAR_CONTAINER_SCANNER_TOKEN: env.SONAR_CONTAINER_SCANNER_TOKEN,
      SONAR_HOST_URL: env.SONAR_HOST_URL,
      SONAR_HTTPS_PROXY_URL: env.SONAR_HTTPS_PROXY_URL,
      SONAR_NO_PROXY: env.SONAR_NO_PROXY,
      CONTAINER_SCANNER_TEST_ENV: env.CONTAINER_SCANNER_TEST_ENV,
    }).toEqual({
      SONAR_CONTAINER_SCANNER_ORG: 'resolved-org',
      SONAR_CONTAINER_SCANNER_TOKEN: 'resolved-token',
      SONAR_HOST_URL: 'https://sonarqube.us',
      SONAR_HTTPS_PROXY_URL: 'http://resolved-proxy.example:8080',
      SONAR_NO_PROXY: 'localhost',
      CONTAINER_SCANNER_TEST_ENV: 'preserved',
    });
    expect(Object.keys(env).map((key) => key.toUpperCase())).not.toContain(
      'SONAR_SCANNER_API_BASE_URL',
    );
    expect(env.SONARQUBE_CLI_TOKEN).toBeUndefined();
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'SONAR_HTTPS_PROXY_URL')).toEqual(
      ['SONAR_HTTPS_PROXY_URL'],
    );
  });

  it('strips standalone SONAR_NO_PROXY and SONAR_CONTAINER_SCANNER_SKIP_UPDATE_CHECK', async () => {
    spyOn(network, 'buildSubprocessNetworkEnv').mockResolvedValue({});
    const baseEnv: NodeJS.ProcessEnv = {
      SONAR_NO_PROXY: 'internal.corp.example',
      sonar_no_proxy: 'lowercase.corp.example',
      SONAR_CONTAINER_SCANNER_SKIP_UPDATE_CHECK: 'false',
      sonar_container_scanner_skip_update_check: '0',
      UNRELATED_VAR: 'kept',
    };

    const env = await prepareContainerScannerEnv(AUTH, baseEnv);
    const upperKeys = Object.keys(env).map((key) => key.toUpperCase());

    expect(upperKeys).not.toContain('SONAR_NO_PROXY');
    expect(upperKeys).not.toContain('SONAR_CONTAINER_SCANNER_SKIP_UPDATE_CHECK');
    expect(env.UNRELATED_VAR).toBe('kept');
  });

  it('does not fail on Server mTLS cert errors and excludes mTLS client-cert vars', async () => {
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
    const baseEnv: NodeJS.ProcessEnv = {
      SONAR_TLS_CLIENT_CERT: '/etc/ssl/client.pem',
      SONAR_TLS_CLIENT_KEY_FILE: '/etc/ssl/client-key.pem',
      SONAR_TLS_CLIENT_PASSPHRASE: 'test-passphrase-placeholder',
      sonar_tls_client_passphrase: 'lowercase-passphrase-placeholder',
      KEEP_ME: 'yes',
    };

    const env = await prepareContainerScannerEnv(AUTH, baseEnv);
    const upperKeys = Object.keys(env).map((key) => key.toUpperCase());

    expect(getNetworkConfigOrThrow).not.toHaveBeenCalled();
    expect(env.SONAR_CA_CERT).toBe('/etc/ssl/corp-ca.pem');
    expect(upperKeys).not.toContain('SONAR_TLS_CLIENT_CERT');
    expect(upperKeys).not.toContain('SONAR_TLS_CLIENT_KEY_FILE');
    expect(upperKeys).not.toContain('SONAR_TLS_CLIENT_PASSPHRASE');
    expect(env.KEEP_ME).toBe('yes');
  });

  it('strips inherited HTTPS_PROXY/https_proxy when SONAR_HTTP_PROXY_URL wins the proxy tier', async () => {
    const baseEnv: NodeJS.ProcessEnv = {
      SONAR_HTTP_PROXY_URL: 'http://sonar-http-proxy.example:8080',
      HTTPS_PROXY: 'http://inherited-https-proxy.example:3128',
      https_proxy: 'http://inherited-lower-https-proxy.example:3128',
      HTTP_PROXY: 'http://inherited-http-proxy.example:3128',
      NO_PROXY: 'inherited.corp.example',
      no_proxy: 'inherited-lower.corp.example',
      KEEP_ME: 'yes',
    };
    spyOn(configRepository, 'getConfigValue').mockResolvedValue(undefined);
    spyOn(network, 'getNetworkConfig').mockImplementation(() =>
      network.resolveNetworkConfig(baseEnv),
    );

    const env = await prepareContainerScannerEnv(AUTH, baseEnv);
    const upperKeys = Object.keys(env).map((key) => key.toUpperCase());

    expect(env.SONAR_HTTP_PROXY_URL).toBe('http://sonar-http-proxy.example:8080');
    expect(env.SONAR_HTTPS_PROXY_URL).toBeUndefined();
    expect(env.SONAR_NO_PROXY).toBeUndefined();
    expect(upperKeys).not.toContain('HTTPS_PROXY');
    expect(upperKeys).not.toContain('HTTP_PROXY');
    expect(upperKeys).not.toContain('NO_PROXY');
    expect(env.KEEP_ME).toBe('yes');
  });

  it('strips ALL_PROXY and all_proxy from the scanner environment', async () => {
    const baseEnv: NodeJS.ProcessEnv = {
      ALL_PROXY: 'socks5://proxy.example:1080',
      all_proxy: 'socks5://lower-proxy.example:1080',
      KEEP_ME: 'yes',
    };
    spyOn(configRepository, 'getConfigValue').mockResolvedValue(undefined);
    spyOn(network, 'getNetworkConfig').mockImplementation(() =>
      network.resolveNetworkConfig(baseEnv),
    );

    const env = await prepareContainerScannerEnv(AUTH, baseEnv);
    const upperKeys = Object.keys(env).map((key) => key.toUpperCase());

    expect(upperKeys).not.toContain('ALL_PROXY');
    expect(env.SONAR_HTTPS_PROXY_URL).toBeUndefined();
    expect(env.SONAR_HTTP_PROXY_URL).toBeUndefined();
    expect(env.KEEP_ME).toBe('yes');
  });

  it('translates generic-only HTTPS_PROXY, HTTP_PROXY, and NO_PROXY to SONAR_* while stripping generic vars', async () => {
    const baseEnv: NodeJS.ProcessEnv = {
      HTTPS_PROXY: 'http://generic-https.example:3128',
      HTTP_PROXY: 'http://generic-http.example:3128',
      NO_PROXY: 'localhost,internal.example',
      all_proxy: 'socks5://ignored.example:1080',
      KEEP_ME: 'yes',
    };
    spyOn(configRepository, 'getConfigValue').mockResolvedValue(undefined);
    spyOn(network, 'getNetworkConfig').mockImplementation(() =>
      network.resolveNetworkConfig(baseEnv),
    );

    const env = await prepareContainerScannerEnv(AUTH, baseEnv);
    const upperKeys = Object.keys(env).map((key) => key.toUpperCase());

    expect(env.SONAR_HTTPS_PROXY_URL).toBe('http://generic-https.example:3128');
    expect(env.SONAR_HTTP_PROXY_URL).toBe('http://generic-http.example:3128');
    expect(env.SONAR_NO_PROXY).toBe('localhost,internal.example');
    expect(upperKeys).not.toContain('HTTPS_PROXY');
    expect(upperKeys).not.toContain('HTTP_PROXY');
    expect(upperKeys).not.toContain('NO_PROXY');
    expect(upperKeys).not.toContain('ALL_PROXY');
    expect(env.KEEP_ME).toBe('yes');
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
  it('passes the options and literal image, isolates the environment and preserves the result', async () => {
    const spawn = spyOn(subprocess, 'spawnProcessWithTimeout').mockResolvedValue(SCAN_RESULT);
    const env = { SONAR_CONTAINER_SCANNER_TOKEN: 'resolved-token' };
    const result = await runContainerScanner(
      'sonar-container-scanner',
      '--licenses',
      {
        containerEngine: 'podman',
        registry: 'registry.example',
        repository: 'my-app',
        tag: '1.2.3',
        timeoutSecs: 5,
        failOn: 'medium',
      },
      env,
    );

    expect(result).toEqual(SCAN_RESULT);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
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
      'The container scanner did not exit after its scan timeout.',
    );
  });

  it('omits undefined optional flags', async () => {
    const spawn = spyOn(subprocess, 'spawnProcessWithTimeout').mockResolvedValue(SCAN_RESULT);

    await runContainerScanner(
      'sonar-container-scanner',
      'alpine:3.20',
      { timeoutSecs: 300, failOn: 'high' },
      {},
    );

    expect(spawn).toHaveBeenCalledWith(
      'sonar-container-scanner',
      [
        '--format',
        'json',
        '--skip-update-check',
        '--timeout-secs=300',
        '--fail-on=high',
        '--',
        'alpine:3.20',
      ],
      expect.objectContaining({
        env: expect.objectContaining({ TMPDIR: expect.any(String) }),
        isolateEnv: true,
        killProcessTree: true,
      }),
      930_000,
      'The container scanner did not exit after its scan timeout.',
    );
  });

  it('clamps the watchdog timeout to MAX_TIMER_MS for large timeoutSecs', async () => {
    const spawn = spyOn(subprocess, 'spawnProcessWithTimeout').mockResolvedValue(SCAN_RESULT);

    await runContainerScanner(
      'sonar-container-scanner',
      'alpine:3.20',
      { timeoutSecs: 10_000_000, failOn: 'high' },
      {},
    );

    expect(spawn).toHaveBeenCalledWith(
      'sonar-container-scanner',
      expect.any(Array),
      expect.any(Object),
      2_147_483_647,
      'The container scanner did not exit after its scan timeout.',
    );
  });

  it.each([
    { signal: 'SIGINT' as const, expectedExitCode: 130 },
    { signal: 'SIGTERM' as const, expectedExitCode: 143 },
  ])(
    'aborts the child signal, exits with $expectedExitCode on $signal, and cleans up listeners',
    async ({ signal, expectedExitCode }) => {
      const existingSigint = process.listenerCount('SIGINT');
      const existingSigterm = process.listenerCount('SIGTERM');
      let capturedSignal: AbortSignal | undefined;

      spyOn(subprocess, 'spawnProcessWithTimeout').mockImplementationOnce((_, __, options) => {
        capturedSignal = options.signal;
        expect(capturedSignal?.aborted).toBe(false);
        const cancel = process.listeners(signal).at(-1);
        cancel?.(signal);
        expect(capturedSignal?.aborted).toBe(true);
        return Promise.resolve(SCAN_RESULT);
      });

      const error = await runContainerScanner(
        'sonar-container-scanner',
        'my-app',
        { timeoutSecs: 5, failOn: 'high' },
        {},
      ).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(CommandFailedError);
      expect((error as CommandFailedError).message).toBe('Container scan cancelled.');
      expect((error as CommandFailedError).exitCode).toBe(expectedExitCode);
      expect(process.listenerCount('SIGINT')).toBe(existingSigint);
      expect(process.listenerCount('SIGTERM')).toBe(existingSigterm);
    },
  );

  it('reports cancellation when spawn rejects concurrently during cancellation', async () => {
    const existingSigint = process.listenerCount('SIGINT');
    const existingSigterm = process.listenerCount('SIGTERM');

    spyOn(subprocess, 'spawnProcessWithTimeout').mockImplementationOnce(() => {
      const cancel = process.listeners('SIGINT').at(-1);
      cancel?.('SIGINT');
      return Promise.reject(new subprocess.ProcessTimedOutError('timed out'));
    });

    const error = await runContainerScanner(
      'sonar-container-scanner',
      'my-app',
      { timeoutSecs: 5, failOn: 'high' },
      {},
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as CommandFailedError).message).toBe('Container scan cancelled.');
    expect((error as CommandFailedError).exitCode).toBe(130);
    expect(process.listenerCount('SIGINT')).toBe(existingSigint);
    expect(process.listenerCount('SIGTERM')).toBe(existingSigterm);
  });

  it('removes signal listeners when spawn rejects without cancellation', async () => {
    const existingSigint = process.listenerCount('SIGINT');
    const existingSigterm = process.listenerCount('SIGTERM');
    const timeoutError = new subprocess.ProcessTimedOutError('hung');
    spyOn(subprocess, 'spawnProcessWithTimeout').mockRejectedValueOnce(timeoutError);

    const error = await runContainerScanner(
      'sonar-container-scanner',
      'my-app',
      { timeoutSecs: 5, failOn: 'high' },
      {},
    ).catch((err: unknown) => err);

    expect(error).toBe(timeoutError);
    expect(process.listenerCount('SIGINT')).toBe(existingSigint);
    expect(process.listenerCount('SIGTERM')).toBe(existingSigterm);
  });

  it('creates a per-run scratch temp dir under the inherited temp root, strips case variants, and removes it on success', async () => {
    const inheritedRoot = mkdtempSync(join(tmpdir(), 'container-runner-root-'));
    let capturedScratchDir: string | undefined;
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    try {
      spyOn(subprocess, 'spawnProcessWithTimeout').mockImplementationOnce((_, __, options) => {
        capturedEnv = options.env;
        capturedScratchDir = options.env?.TMPDIR;
        expect(capturedScratchDir).toBeDefined();
        expect(dirname(capturedScratchDir!)).toBe(inheritedRoot);
        expect(existsSync(capturedScratchDir!)).toBe(true);
        writeFileSync(join(capturedScratchDir!, 'exported-layer.tar'), 'scratch-data');
        return Promise.resolve(SCAN_RESULT);
      });

      const result = await runContainerScanner(
        'sonar-container-scanner',
        'alpine:3.20',
        { timeoutSecs: 5, failOn: 'high' },
        { TMPDIR: inheritedRoot, tmpdir: '/lowercase/old', KEEP_ME: 'yes' },
      );

      expect(result).toEqual(SCAN_RESULT);
      expect(capturedEnv?.KEEP_ME).toBe('yes');
      expect(
        Object.keys(capturedEnv ?? {}).filter((key) => key.toUpperCase() === 'TMPDIR'),
      ).toEqual(['TMPDIR']);
      if (process.platform === 'win32') {
        expect(capturedEnv?.TMP).toBe(capturedScratchDir);
        expect(capturedEnv?.TEMP).toBe(capturedScratchDir);
      }
      expect(existsSync(capturedScratchDir!)).toBe(false);
    } finally {
      rmSync(inheritedRoot, { recursive: true, force: true });
    }
  });

  it('removes the per-run scratch temp dir on spawn failure', async () => {
    let capturedScratchDir: string | undefined;
    const timeoutError = new subprocess.ProcessTimedOutError('hung');
    spyOn(subprocess, 'spawnProcessWithTimeout').mockImplementationOnce((_, __, options) => {
      capturedScratchDir = options.env?.TMPDIR;
      expect(capturedScratchDir).toBeDefined();
      expect(existsSync(capturedScratchDir!)).toBe(true);
      writeFileSync(join(capturedScratchDir!, 'partial-export.tar'), 'partial');
      return Promise.reject(timeoutError);
    });

    const error = await runContainerScanner(
      'sonar-container-scanner',
      'alpine:3.20',
      { timeoutSecs: 5, failOn: 'high' },
      {},
    ).catch((err: unknown) => err);

    expect(error).toBe(timeoutError);
    expect(existsSync(capturedScratchDir!)).toBe(false);
  });

  it('removes the per-run scratch temp dir on signal abort', async () => {
    let capturedScratchDir: string | undefined;
    spyOn(subprocess, 'spawnProcessWithTimeout').mockImplementationOnce((_, __, options) => {
      capturedScratchDir = options.env?.TMPDIR;
      expect(capturedScratchDir).toBeDefined();
      expect(existsSync(capturedScratchDir!)).toBe(true);
      writeFileSync(join(capturedScratchDir!, 'aborted-export.tar'), 'aborted');
      const cancel = process.listeners('SIGINT').at(-1);
      cancel?.('SIGINT');
      return Promise.resolve(SCAN_RESULT);
    });

    const error = await runContainerScanner(
      'sonar-container-scanner',
      'alpine:3.20',
      { timeoutSecs: 5, failOn: 'high' },
      {},
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as CommandFailedError).exitCode).toBe(130);
    expect(existsSync(capturedScratchDir!)).toBe(false);
  });

  it('does not mask scan outcomes if scratch temp dir cleanup fails', async () => {
    let capturedScratchDir: string | undefined;
    spyOn(subprocess, 'spawnProcessWithTimeout').mockImplementationOnce((_, __, options) => {
      capturedScratchDir = options.env?.TMPDIR;
      return Promise.resolve(SCAN_RESULT);
    });
    const rmSpy = spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('EBUSY: file locked');
    });

    try {
      const result = await runContainerScanner(
        'sonar-container-scanner',
        'alpine:3.20',
        { timeoutSecs: 5, failOn: 'high' },
        {},
      );

      expect(result).toEqual(SCAN_RESULT);
      expect(rmSpy).toHaveBeenCalledWith(capturedScratchDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    } finally {
      rmSpy.mockRestore();
      if (capturedScratchDir) {
        rmSync(capturedScratchDir, { recursive: true, force: true });
      }
    }
  });
});
