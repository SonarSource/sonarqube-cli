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

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { OWNER_ONLY_FILE_MODE } from '@/core/config-constants.ts';
import {
  buildFetchNetworkOptions,
  getNetworkConfigOrThrow,
} from '@/core/host/connectivity/network-config.ts';
import { pemToPkcs12 } from '@/core/host/crypto/pkcs12.ts';
import { spawnProcessWithTimeout } from '@/core/process/process.ts';

const KEYTOOL_TIMEOUT_MS = 30_000;
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

async function importCertificate(
  javaPath: string,
  certPath: string,
  alias: string,
  truststorePath: string,
  password: string,
): Promise<void> {
  // Scanner distributions omit the keytool executable but retain its java.base module.
  const result = await spawnProcessWithTimeout(
    javaPath,
    [
      '-m',
      'java.base/sun.security.tools.keytool.Main',
      '-importcert',
      '-noprompt',
      '-alias',
      alias,
      '-file',
      certPath,
      '-keystore',
      truststorePath,
      '-storetype',
      'PKCS12',
      '-storepass:env',
      'SONAR_INIT_STORE_PASSWORD',
    ],
    { env: { SONAR_INIT_STORE_PASSWORD: password } },
    KEYTOOL_TIMEOUT_MS,
    'CA certificate import timed out.',
  );
  if (result.exitCode !== 0) {
    throw new CommandFailedError(
      'Could not import the configured CA certificates into the scanner truststore.',
    );
  }
}

function readCertificates(caPath: string): string[] {
  const certificates = readFileSync(caPath, 'utf8').match(PEM_CERTIFICATE);
  if (!certificates?.length) {
    throw new CommandFailedError('The configured CA file contains no PEM certificates.');
  }
  return certificates;
}

/** Imports each certificate one after the other, since they all write the same keystore file. */
async function importCertificates(
  caPath: string,
  javaPath: string,
  temporaryDirectory: string,
  truststorePath: string,
  password: string,
): Promise<void> {
  await readCertificates(caPath).reduce<Promise<void>>(async (previous, certificate, index) => {
    await previous;
    const certPath = join(temporaryDirectory, `ca-${index}.pem`);
    writeFileSync(certPath, certificate, { mode: OWNER_ONLY_FILE_MODE });
    await importCertificate(javaPath, certPath, `init-ca-${index}`, truststorePath, password);
  }, Promise.resolve());
}

type ClientCertificate = NonNullable<
  Awaited<ReturnType<typeof getNetworkConfigOrThrow>>['clientCert']
>;

function assertDetachable(client: ClientCertificate): void {
  if (client.format !== 'pkcs12') {
    throw new CommandFailedError('A PEM client key cannot be used with --detach.', {
      remediationHint:
        'Convert the client certificate to PKCS12, or run the analysis without --detach.',
    });
  }
}

function scannerProxyUrl(proxy: string): URL {
  const url = new URL(proxy);
  if (url.protocol !== 'http:') {
    throw new CommandFailedError('The SonarScanner requires an HTTP proxy URL.');
  }
  return url;
}

async function resolveProxy(
  serverUrl: string,
  config: Awaited<ReturnType<typeof getNetworkConfigOrThrow>>,
): Promise<string | undefined> {
  // Bun reads generic proxies implicitly; Java needs an explicit proxy after NO_PROXY matching.
  const options = await buildFetchNetworkOptions(serverUrl, {
    ...config,
    proxy: config.proxy ? { ...config.proxy, explicit: true } : null,
  });
  return options.proxy || undefined;
}

/**
 * Rejects what the scanner cannot use before the scanner is downloaded, so the user does not wait
 * through the download to learn that the proxy, the CA bundle or --detach is unsupported.
 */
export async function assertScannerNetworkUsable(
  serverUrl: string,
  detached: boolean,
): Promise<void> {
  const config = await getNetworkConfigOrThrow();
  const proxy = await resolveProxy(serverUrl, config);
  if (proxy) scannerProxyUrl(proxy);
  if (config.caCert) readCertificates(config.caCert.path);
  if (detached && config.clientCert) assertDetachable(config.clientCert);
}

export async function scannerNetworkEnv(
  serverUrl: string,
  javaPath: string,
  temporaryDirectory: string,
  detached = false,
): Promise<NodeJS.ProcessEnv> {
  const config = await getNetworkConfigOrThrow();
  const env: NodeJS.ProcessEnv = {
    SONAR_SCANNER_JSON_PARAMS: '{}',
    SONARQUBE_SCANNER_PARAMS: '{}',
    SONAR_SCANNER_PROXY_HOST: undefined,
    SONAR_SCANNER_PROXY_PORT: undefined,
    SONAR_SCANNER_PROXY_USER: undefined,
    SONAR_SCANNER_PROXY_PASSWORD: undefined,
  };
  const proxy = await resolveProxy(serverUrl, config);
  if (proxy) {
    const url = scannerProxyUrl(proxy);
    // `hostname` keeps the brackets of an IPv6 literal, which Java cannot resolve.
    env.SONAR_SCANNER_PROXY_HOST = url.hostname.replace(/^\[|]$/g, '');
    env.SONAR_SCANNER_PROXY_PORT = url.port || '80';
    env.SONAR_SCANNER_PROXY_USER = decodeURIComponent(url.username);
    env.SONAR_SCANNER_PROXY_PASSWORD = decodeURIComponent(url.password);
  }

  if (config.caCert) {
    const truststorePath = join(temporaryDirectory, 'truststore.p12');
    const password = randomUUID();
    await importCertificates(
      config.caCert.path,
      javaPath,
      temporaryDirectory,
      truststorePath,
      password,
    );
    env.SONAR_SCANNER_TRUSTSTORE_PATH = truststorePath;
    env.SONAR_SCANNER_TRUSTSTORE_PASSWORD = password;
  }

  if (config.clientCert) {
    const client = config.clientCert;
    if (client.format === 'pkcs12') {
      env.SONAR_SCANNER_KEYSTORE_PATH = client.certPath;
      env.SONAR_SCANNER_KEYSTORE_PASSWORD = client.passphrase ?? '';
    } else {
      if (detached) assertDetachable(client);
      const path = join(temporaryDirectory, 'keystore.p12');
      const bytes = pemToPkcs12(client.resolvedCertPem, client.resolvedKeyPem, client.passphrase);
      writeFileSync(path, bytes, { mode: OWNER_ONLY_FILE_MODE });
      env.SONAR_SCANNER_KEYSTORE_PATH = path;
      env.SONAR_SCANNER_KEYSTORE_PASSWORD = '';
    }
  }
  return env;
}
