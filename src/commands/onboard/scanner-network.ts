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
import {
  buildFetchNetworkOptions,
  getNetworkConfigOrThrow,
} from '@/core/host/connectivity/network-config.ts';
import { pemToPkcs12 } from '@/core/host/crypto/pkcs12.ts';
import { scannerJavaPath } from '@/core/host/install/sonar-scanner.ts';
import { spawnProcessWithTimeout } from '@/core/process/process.ts';

export async function scannerNetworkEnv(
  serverUrl: string,
  scannerHome: string,
  temporaryDirectory: string,
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
  // Bun reads generic proxies implicitly; Java needs an explicit proxy after NO_PROXY matching.
  const options = await buildFetchNetworkOptions(serverUrl, {
    ...config,
    proxy: config.proxy ? { ...config.proxy, explicit: true } : null,
  });
  const proxy = options.proxy;
  if (proxy) {
    const url = new URL(proxy);
    if (url.protocol !== 'http:')
      throw new CommandFailedError('SonarScanner onboarding requires an HTTP proxy URL.');
    env.SONAR_SCANNER_PROXY_HOST = url.hostname;
    env.SONAR_SCANNER_PROXY_PORT = url.port || '80';
    env.SONAR_SCANNER_PROXY_USER = decodeURIComponent(url.username);
    env.SONAR_SCANNER_PROXY_PASSWORD = decodeURIComponent(url.password);
  }

  if (config.caCert) {
    const truststorePath = join(temporaryDirectory, 'truststore.p12');
    const password = randomUUID();
    const content = readFileSync(config.caCert.path, 'utf8');
    const certificates = content.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    );
    if (!certificates?.length)
      throw new CommandFailedError('The configured CA file contains no PEM certificates.');
    for (const [index, certificate] of certificates.entries()) {
      const certPath = join(temporaryDirectory, `ca-${index}.pem`);
      writeFileSync(certPath, certificate, { mode: 0o600 });
      // Scanner distributions omit the keytool executable but retain its java.base module.
      const result = await spawnProcessWithTimeout(
        scannerJavaPath(scannerHome),
        [
          '-m',
          'java.base/sun.security.tools.keytool.Main',
          '-importcert',
          '-noprompt',
          '-alias',
          `onboard-ca-${index}`,
          '-file',
          certPath,
          '-keystore',
          truststorePath,
          '-storetype',
          'PKCS12',
          '-storepass:env',
          'SONAR_ONBOARD_STORE_PASSWORD',
        ],
        { env: { SONAR_ONBOARD_STORE_PASSWORD: password } },
        30000,
        'CA certificate import timed out.',
      );
      if (result.exitCode !== 0)
        throw new CommandFailedError(
          'Could not import the configured CA certificates into the scanner truststore.',
        );
    }
    env.SONAR_SCANNER_TRUSTSTORE_PATH = truststorePath;
    env.SONAR_SCANNER_TRUSTSTORE_PASSWORD = password;
  }

  if (config.clientCert) {
    const client = config.clientCert;
    if (client.format === 'pkcs12') {
      env.SONAR_SCANNER_KEYSTORE_PATH = client.certPath;
      env.SONAR_SCANNER_KEYSTORE_PASSWORD = client.passphrase ?? '';
    } else {
      const path = join(temporaryDirectory, 'keystore.p12');
      const bytes = pemToPkcs12(client.resolvedCertPem, client.resolvedKeyPem, client.passphrase);
      writeFileSync(path, bytes, { mode: 0o600 });
      env.SONAR_SCANNER_KEYSTORE_PATH = path;
      env.SONAR_SCANNER_KEYSTORE_PASSWORD = '';
    }
  }
  return env;
}
