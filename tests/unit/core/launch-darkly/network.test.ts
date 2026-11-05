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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createProxy } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import forge from 'node-forge';

import { clearNetworkConfigCache } from '@/core/host/connectivity/network-config.ts';
import { fetchFlagsFromLaunchDarkly } from '@/core/launch-darkly';

import { createKeychainTestHandle } from '../host/keychain-test-handle.ts';

const identity = {
  connectionType: 'cloud' as const,
  userUuid: 'user-1',
  organizationUuidV4: 'org-1',
  enterpriseUuid: null,
  sqsInstallationId: null,
};
const keychain = createKeychainTestHandle();
const networkVariables = [
  'SONAR_USER_HOME',
  'SONAR_HTTPS_PROXY_URL',
  'SONAR_HTTP_PROXY_URL',
  'SONAR_NO_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SONAR_CA_CERT',
  'SONAR_TLS_CLIENT_CERT',
  'SONAR_TLS_CLIENT_KEY_FILE',
  'SONAR_TLS_CLIENT_PASSPHRASE',
];

describe('LaunchDarkly network policy with real HTTPS and CONNECT', () => {
  let previous: Record<string, string | undefined>;
  let directory: string;
  let proxy: ReturnType<typeof createProxy>;
  let server: ReturnType<typeof createTlsServer>;
  let sockets: Set<Duplex>;
  let tunnels: string[];
  let requests: string[];

  beforeEach(async () => {
    previous = Object.fromEntries(networkVariables.map((key) => [key, process.env[key]]));
    for (const key of networkVariables) delete process.env[key];
    directory = mkdtempSync(join(tmpdir(), 'ld-network-'));
    process.env.SONAR_USER_HOME = directory;
    keychain.setup();
    clearNetworkConfigCache();
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date(Date.now() + 86_400_000);
    cert.setSubject([{ name: 'commonName', value: 'clientsdk.launchdarkly.com' }]);
    cert.setIssuer(cert.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'clientsdk.launchdarkly.com' }] },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const pem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
    const certPath = join(directory, 'cert.pem');
    const keyPath = join(directory, 'key.pem');
    writeFileSync(certPath, pem);
    writeFileSync(keyPath, keyPem, { mode: 0o600 });
    process.env.SONAR_CA_CERT = certPath;
    process.env.SONAR_TLS_CLIENT_CERT = certPath;
    process.env.SONAR_TLS_CLIENT_KEY_FILE = keyPath;
    requests = [];
    tunnels = [];
    sockets = new Set();
    server = createTlsServer(
      { cert: pem, key: keyPem, ca: pem, requestCert: true, rejectUnauthorized: true },
      (req, res) => {
        requests.push(req.url!);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ enabled: { value: true }, disabled: { value: false } }));
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing TLS listener');
    proxy = createProxy();
    proxy.on('connect', (req, downstream, head) => {
      tunnels.push(req.url!);
      sockets.add(downstream);
      const upstream = connect(address.port, '127.0.0.1', () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        downstream.pipe(upstream).pipe(downstream);
      });
      sockets.add(upstream);
      downstream.on('error', () => upstream.destroy());
      upstream.on('error', () => downstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string')
      throw new Error('Missing proxy listener');
    process.env.SONAR_HTTPS_PROXY_URL = `http://127.0.0.1:${proxyAddress.port}`;
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => proxy.close(() => resolve())),
    ]);
    clearNetworkConfigCache();
    keychain.teardown();
    for (const key of networkVariables) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it('retrieves flags through the Sonar proxy with a custom CA and required client certificate', async () => {
    expect(await fetchFlagsFromLaunchDarkly(identity)).toEqual({ enabled: true, disabled: false });
    expect(tunnels).toEqual(['clientsdk.launchdarkly.com:443']);
    expect(requests).toHaveLength(1);
    const context = JSON.parse(Buffer.from(requests[0].split('/').at(-1)!, 'base64url').toString());
    expect(context.user.key).toBe('user-1');
  });

  it('fails closed when the configured client key is missing', async () => {
    process.env.SONAR_TLS_CLIENT_KEY_FILE = join(directory, 'missing-key.pem');
    expect(await fetchFlagsFromLaunchDarkly(identity)).toBeNull();
    expect(tunnels).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('rejects an untrusted server instead of dropping the custom TLS policy', async () => {
    delete process.env.SONAR_CA_CERT;
    expect(await fetchFlagsFromLaunchDarkly(identity)).toBeNull();
    expect(requests).toEqual([]);
  });
});
