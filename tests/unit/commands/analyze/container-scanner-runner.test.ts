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

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import * as network from '@/core/host/connectivity/network-config.ts';
import * as subprocess from '@/core/process/process.ts';

import {
  prepareContainerScannerEnv,
  runContainerScanner,
} from '../../../../src/commands/analyze/container-scanner-runner.ts';
import { restoreEnv } from '../../../_common/isolated-cli-env.ts';

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
    const resolvedNetwork = { proxy: null, caCert: null, clientCert: null };
    spyOn(network, 'getNetworkConfigOrThrow').mockResolvedValue(resolvedNetwork);
    const subprocessEnv = spyOn(network, 'buildSubprocessNetworkEnv').mockResolvedValue({
      SONAR_HTTPS_PROXY_URL: 'http://resolved-proxy.example:8080',
      SONAR_NO_PROXY: 'localhost',
    });
    const inherited = {
      sonar_scanner_api_base_url: 'https://inherited-endpoint.example',
      SONARQUBE_CLI_TOKEN: 'inherited-token',
      SONAR_CONTAINER_SCANNER_TOKEN: 'inherited-scanner-token',
      sonar_https_proxy_url: 'http://inherited-proxy.example:8080',
      CONTAINER_SCANNER_TEST_ENV: 'preserved',
    };
    const original = Object.keys(inherited).map((key) => [key, process.env[key]] as const);
    Object.assign(process.env, inherited);

    try {
      const env = await prepareContainerScannerEnv(AUTH);

      expect(subprocessEnv).toHaveBeenCalledWith(resolvedNetwork);
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
      expect(
        Object.keys(env).filter((key) => key.toUpperCase() === 'SONAR_HTTPS_PROXY_URL'),
      ).toEqual(['SONAR_HTTPS_PROXY_URL']);
    } finally {
      for (const [key, value] of original) restoreEnv(key, value);
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
    const getNetworkConfig = spyOn(network, 'getNetworkConfigOrThrow');

    await rejects(prepareContainerScannerEnv(serverAuth), /only on SonarQube Cloud/);
    await rejects(
      prepareContainerScannerEnv(missingOrg),
      /Could not determine the SonarQube Cloud organization/,
    );
    expect(getNetworkConfig).not.toHaveBeenCalled();
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
      expect.objectContaining({ env, isolateEnv: true }),
      45_000,
      'The container scanner did not exit after its scan timeout.',
    );
  });

  it.each([
    { early: true, timing: 'before' },
    { early: false, timing: 'after' },
  ])('stops the child when cancelled $timing the spawn callback', async ({ early }) => {
    const existingListeners = process.listenerCount('SIGTERM');
    const kill = mock(() => {});
    spyOn(subprocess, 'spawnProcessWithTimeout').mockImplementationOnce((_, __, options) => {
      const cancel = process.listeners('SIGTERM').at(-1);
      if (!early) options.onSpawn?.(kill);
      cancel?.('SIGTERM');
      if (early) options.onSpawn?.(kill);
      return Promise.resolve(SCAN_RESULT);
    });

    await rejects(
      runContainerScanner(
        'sonar-container-scanner',
        'my-app',
        { timeoutSecs: 5, failOn: 'high' },
        {},
      ),
      /Container scan cancelled/,
    );
    expect(kill).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('SIGTERM')).toBe(existingListeners);
  });
});
