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

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  assertScannerNetworkUsable,
  scannerNetworkEnv,
} from '@/commands/init/scan/scanner-network.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';
import { clearNetworkConfigCache } from '@/core/host/connectivity/network-config.ts';

import { restoreEnv } from '../../../_common/isolated-cli-env.ts';
import { isolateNetworkEnv } from '../../../_common/network-env.ts';
import { createKeychainTestHandle } from '../../core/host/keychain-test-handle.ts';

const FIXTURES = join(import.meta.dir, '../../../fixtures/client-cert');
const CERT_PEM = join(FIXTURES, 'client-cert.pem');
const KEY_PEM = join(FIXTURES, 'client-key.pem');
const ENCRYPTED_KEY_PEM = join(FIXTURES, 'client-key-encrypted.pem');
const P12 = join(FIXTURES, 'client-cert.p12');
const P12_PASSPHRASE = 'testpassword';

const HTTP_SERVER = 'http://sonar.example';
const HTTPS_SERVER = 'https://sonar.example';

const keychain = createKeychainTestHandle();
const posixOnly = process.platform === 'win32' ? describe.skip : describe;
let restoreNetworkEnv: () => void;
let previousUserHome: string | undefined;
let directory: string;

beforeEach(() => {
  restoreNetworkEnv = isolateNetworkEnv();
  previousUserHome = process.env[ENV_SONAR_USER_HOME];
  directory = mkdtempSync(join(tmpdir(), 'scanner-network-test-'));
  process.env[ENV_SONAR_USER_HOME] = join(directory, 'user-home');
  clearNetworkConfigCache();
  keychain.setup();
});

afterEach(() => {
  clearNetworkConfigCache();
  keychain.teardown();
  restoreNetworkEnv();
  restoreEnv(ENV_SONAR_USER_HOME, previousUserHome);
  rmSync(directory, { recursive: true, force: true });
});

function useEnv(values: Record<string, string>): void {
  Object.assign(process.env, values);
  clearNetworkConfigCache();
}

function caFile(certificates: number): string {
  const certificate = readFileSync(CERT_PEM, 'utf8').trim();
  const path = join(directory, 'ca.pem');
  writeFileSync(path, Array.from({ length: certificates }, () => certificate).join('\n'));
  return path;
}

/** A stand-in for `java`: records its arguments and the store password it was handed. */
function fakeJava(exitCode: number): string {
  const path = join(directory, 'java');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `echo "$*" >> "${directory}/java-args.log"`,
      `echo "$SONAR_INIT_STORE_PASSWORD" >> "${directory}/java-password.log"`,
      `exit ${exitCode}`,
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return path;
}

describe('scannerNetworkEnv', () => {
  it('sets no proxy, truststore or keystore for a plain connection', async () => {
    const env = await scannerNetworkEnv(HTTPS_SERVER, 'unused', directory);

    expect(env.SONAR_SCANNER_JSON_PARAMS).toBe('{}');
    expect(env.SONAR_SCANNER_PROXY_HOST).toBeUndefined();
    expect(env.SONAR_SCANNER_TRUSTSTORE_PATH).toBeUndefined();
    expect(env.SONAR_SCANNER_KEYSTORE_PATH).toBeUndefined();
  });

  describe('proxy', () => {
    it('maps an HTTP proxy, decoding its credentials', async () => {
      useEnv({ SONAR_HTTP_PROXY_URL: 'http://us%40er:p%40ss@proxy.local:3128' });

      const env = await scannerNetworkEnv(HTTP_SERVER, 'unused', directory);

      expect(env.SONAR_SCANNER_PROXY_HOST).toBe('proxy.local');
      expect(env.SONAR_SCANNER_PROXY_PORT).toBe('3128');
      expect(env.SONAR_SCANNER_PROXY_USER).toBe('us@er');
      expect(env.SONAR_SCANNER_PROXY_PASSWORD).toBe('p@ss');
    });

    it('defaults to port 80 and empty credentials', async () => {
      useEnv({ SONAR_HTTP_PROXY_URL: 'http://proxy.local' });

      const env = await scannerNetworkEnv(HTTP_SERVER, 'unused', directory);

      expect(env.SONAR_SCANNER_PROXY_PORT).toBe('80');
      expect(env.SONAR_SCANNER_PROXY_USER).toBe('');
      expect(env.SONAR_SCANNER_PROXY_PASSWORD).toBe('');
    });

    it('strips the brackets of an IPv6 proxy host, which Java cannot resolve', async () => {
      useEnv({ SONAR_HTTP_PROXY_URL: 'http://[::1]:3128' });

      const env = await scannerNetworkEnv(HTTP_SERVER, 'unused', directory);

      expect(env.SONAR_SCANNER_PROXY_HOST).toBe('::1');
    });

    it('uses no proxy for a host that NO_PROXY exempts', async () => {
      useEnv({ SONAR_HTTP_PROXY_URL: 'http://proxy.local:3128', SONAR_NO_PROXY: 'sonar.example' });

      const env = await scannerNetworkEnv(HTTP_SERVER, 'unused', directory);

      expect(env.SONAR_SCANNER_PROXY_HOST).toBeUndefined();
    });

    it('refuses an HTTPS proxy, which the scanner cannot use', async () => {
      useEnv({ SONAR_HTTPS_PROXY_URL: 'https://proxy.local:8443' });

      const error = await scannerNetworkEnv(HTTPS_SERVER, 'unused', directory).catch(
        (cause: unknown) => cause,
      );

      expect(error).toBeInstanceOf(CommandFailedError);
      expect((error as CommandFailedError).message).toBe(
        'The SonarScanner requires an HTTP proxy URL.',
      );
    });
  });

  posixOnly('CA certificates', () => {
    it('imports every certificate into one truststore, handing java the password by env', async () => {
      useEnv({ SONAR_CA_CERT: caFile(2) });

      const env = await scannerNetworkEnv(HTTPS_SERVER, fakeJava(0), directory);

      expect(env.SONAR_SCANNER_TRUSTSTORE_PATH).toBe(join(directory, 'truststore.p12'));
      const password = env.SONAR_SCANNER_TRUSTSTORE_PASSWORD ?? '';
      expect(password.length).toBeGreaterThan(0);
      const calls = readFileSync(join(directory, 'java-args.log'), 'utf8').trim().split('\n');
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('-alias init-ca-0');
      expect(calls[1]).toContain('-alias init-ca-1');
      expect(calls[0]).toContain('-storepass:env SONAR_INIT_STORE_PASSWORD');
      expect(calls.join('\n')).not.toContain(password);
      const passwords = readFileSync(join(directory, 'java-password.log'), 'utf8').trim();
      expect(new Set(passwords.split('\n'))).toEqual(new Set([password]));
    });

    it('fails when the certificate import fails', async () => {
      useEnv({ SONAR_CA_CERT: caFile(1) });

      const error = await scannerNetworkEnv(HTTPS_SERVER, fakeJava(1), directory).catch(
        (cause: unknown) => cause,
      );

      expect((error as CommandFailedError).message).toBe(
        'Could not import the configured CA certificates into the scanner truststore.',
      );
    });
  });

  it('rejects a CA file that holds no PEM certificate', async () => {
    const path = join(directory, 'empty-ca.pem');
    writeFileSync(path, 'not a certificate');
    useEnv({ SONAR_CA_CERT: path });

    const error = await scannerNetworkEnv(HTTPS_SERVER, 'unused', directory).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
  });

  describe('client certificate', () => {
    it('uses a PKCS12 client certificate in place', async () => {
      useEnv({ SONAR_TLS_CLIENT_CERT: P12, SONAR_TLS_CLIENT_PASSPHRASE: P12_PASSPHRASE });

      const env = await scannerNetworkEnv(HTTPS_SERVER, 'unused', directory);

      expect(env.SONAR_SCANNER_KEYSTORE_PATH).toBe(P12);
      expect(env.SONAR_SCANNER_KEYSTORE_PASSWORD).toBe(P12_PASSPHRASE);
    });

    it('converts a PEM client certificate to a keystore with an empty password', async () => {
      useEnv({ SONAR_TLS_CLIENT_CERT: CERT_PEM, SONAR_TLS_CLIENT_KEY_FILE: KEY_PEM });

      const env = await scannerNetworkEnv(HTTPS_SERVER, 'unused', directory);

      expect(env.SONAR_SCANNER_KEYSTORE_PATH).toBe(join(directory, 'keystore.p12'));
      expect(existsSync(join(directory, 'keystore.p12'))).toBe(true);
      expect(env.SONAR_SCANNER_KEYSTORE_PASSWORD).toBe('');
    });

    it('converts a passphrase-protected PEM client key', async () => {
      useEnv({
        SONAR_TLS_CLIENT_CERT: CERT_PEM,
        SONAR_TLS_CLIENT_KEY_FILE: ENCRYPTED_KEY_PEM,
        SONAR_TLS_CLIENT_PASSPHRASE: P12_PASSPHRASE,
      });

      const env = await scannerNetworkEnv(HTTPS_SERVER, 'unused', directory);

      expect(existsSync(env.SONAR_SCANNER_KEYSTORE_PATH ?? '')).toBe(true);
      expect(env.SONAR_SCANNER_KEYSTORE_PASSWORD).toBe('');
    });

    it('refuses a PEM client key with --detach, since its keystore would stay on disk', async () => {
      useEnv({ SONAR_TLS_CLIENT_CERT: CERT_PEM, SONAR_TLS_CLIENT_KEY_FILE: KEY_PEM });

      const error = await scannerNetworkEnv(HTTPS_SERVER, 'unused', directory, true).catch(
        (cause: unknown) => cause,
      );

      expect((error as CommandFailedError).message).toBe(
        'A PEM client key cannot be used with --detach.',
      );
      expect(existsSync(join(directory, 'keystore.p12'))).toBe(false);
    });

    it('allows a PKCS12 client certificate with --detach', async () => {
      useEnv({ SONAR_TLS_CLIENT_CERT: P12, SONAR_TLS_CLIENT_PASSPHRASE: P12_PASSPHRASE });

      const env = await scannerNetworkEnv(HTTPS_SERVER, 'unused', directory, true);

      expect(env.SONAR_SCANNER_KEYSTORE_PATH).toBe(P12);
    });
  });
});

describe('assertScannerNetworkUsable', () => {
  it('accepts a plain connection', async () => {
    expect(await assertScannerNetworkUsable(HTTPS_SERVER, false)).toBeUndefined();
    expect(await assertScannerNetworkUsable(HTTPS_SERVER, true)).toBeUndefined();
  });

  it('accepts an HTTP proxy and a CA bundle with certificates', async () => {
    useEnv({ SONAR_HTTP_PROXY_URL: 'http://proxy.local:3128', SONAR_CA_CERT: caFile(1) });

    expect(await assertScannerNetworkUsable(HTTP_SERVER, false)).toBeUndefined();
  });

  it('rejects an HTTPS proxy before anything is downloaded', async () => {
    useEnv({ SONAR_HTTPS_PROXY_URL: 'https://proxy.local:8443' });

    const error = await assertScannerNetworkUsable(HTTPS_SERVER, false).catch(
      (cause: unknown) => cause,
    );

    expect((error as CommandFailedError).message).toBe(
      'The SonarScanner requires an HTTP proxy URL.',
    );
  });

  it('rejects a CA bundle that holds no PEM certificate', async () => {
    const path = join(directory, 'empty-ca.pem');
    writeFileSync(path, 'not a certificate');
    useEnv({ SONAR_CA_CERT: path });

    const error = await assertScannerNetworkUsable(HTTPS_SERVER, false).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
  });

  it('rejects a PEM client key only when the scan is detached', async () => {
    useEnv({ SONAR_TLS_CLIENT_CERT: CERT_PEM, SONAR_TLS_CLIENT_KEY_FILE: KEY_PEM });

    await assertScannerNetworkUsable(HTTPS_SERVER, false);
    const error = await assertScannerNetworkUsable(HTTPS_SERVER, true).catch(
      (cause: unknown) => cause,
    );

    expect((error as CommandFailedError).message).toBe(
      'A PEM client key cannot be used with --detach.',
    );
  });

  it('accepts a PKCS12 client certificate when the scan is detached', async () => {
    useEnv({ SONAR_TLS_CLIENT_CERT: P12, SONAR_TLS_CLIENT_PASSPHRASE: P12_PASSPHRASE });

    expect(await assertScannerNetworkUsable(HTTPS_SERVER, true)).toBeUndefined();
  });
});
