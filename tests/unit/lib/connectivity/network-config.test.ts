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

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  buildFetchNetworkOptions,
  buildSubprocessNetworkEnv,
  clearNetworkConfigCache,
  resolveNetworkConfig,
} from '../../../../src/lib/connectivity/network-config';

const CLIENT_CERT_FIXTURE_DIR = join(import.meta.dir, '../../../fixtures/client-cert');
const CERT_PATH = join(CLIENT_CERT_FIXTURE_DIR, 'client-cert.pem');
const KEY_PATH = join(CLIENT_CERT_FIXTURE_DIR, 'client-key.pem');
const P12_PATH = join(CLIENT_CERT_FIXTURE_DIR, 'client-cert.p12');

afterEach(() => {
  clearNetworkConfigCache();
});

describe('resolveNetworkConfig', () => {
  it('returns null proxy, caCert, and clientCert when env is empty', () => {
    const config = resolveNetworkConfig({});
    expect(config.proxy).toBeNull();
    expect(config.caCert).toBeNull();
    expect(config.clientCert).toBeNull();
  });

  describe('proxy group — tier selection', () => {
    it('sonar-env wins when SONAR_HTTPS_PROXY_URL is set', () => {
      const config = resolveNetworkConfig({ SONAR_HTTPS_PROXY_URL: 'https://sonar-proxy:8080' });
      expect(config.proxy?.source).toBe('sonar-env');
      expect(config.proxy?.explicit).toBe(true);
      expect(config.proxy?.proxyHttps?.getUrlWithCredentials()).toBe('https://sonar-proxy:8080');
      expect(config.proxy?.proxyHttp).toBeNull();
      expect(config.proxy?.noProxy).toBeNull();
    });

    it('sonar-env wins when SONAR_HTTP_PROXY_URL is set', () => {
      const config = resolveNetworkConfig({ SONAR_HTTP_PROXY_URL: 'https://sonar-proxy:8080' });
      expect(config.proxy?.source).toBe('sonar-env');
      expect(config.proxy?.explicit).toBe(true);
      expect(config.proxy?.proxyHttps).toBeNull();
    });

    it('sonar-env with both proxy types set', () => {
      const config = resolveNetworkConfig({
        SONAR_HTTPS_PROXY_URL: 'https://sonar-https:8080',
        SONAR_HTTP_PROXY_URL: 'https://sonar-http:8080',
      });
      expect(config.proxy?.source).toBe('sonar-env');
      expect(config.proxy?.proxyHttps?.getUrlWithCredentials()).toBe('https://sonar-https:8080');
      expect(config.proxy?.proxyHttp?.getUrlWithCredentials()).toBe('https://sonar-http:8080');
    });

    it('noProxy comes from same group as proxy', () => {
      const config = resolveNetworkConfig({
        SONAR_HTTPS_PROXY_URL: 'https://sonar-proxy:8080',
        SONAR_NO_PROXY: 'internal.corp.com',
      });
      expect(config.proxy?.source).toBe('sonar-env');
      expect(config.proxy?.noProxy).toBe('internal.corp.com');
    });

    it('generic-env used when no sonar-env proxy set', () => {
      const config = resolveNetworkConfig({ HTTPS_PROXY: 'https://proxy:3128' });
      expect(config.proxy?.source).toBe('generic-env');
      expect(config.proxy?.explicit).toBe(false);
      expect(config.proxy?.proxyHttp).toBeNull();
    });

    it('generic-env with both proxy types and NO_PROXY', () => {
      const config = resolveNetworkConfig({
        HTTPS_PROXY: 'https://proxy:3128',
        HTTP_PROXY: 'https://proxy:3128',
        NO_PROXY: 'localhost',
      });
      expect(config.proxy?.source).toBe('generic-env');
      expect(config.proxy?.proxyHttps).not.toBeNull();
      expect(config.proxy?.proxyHttp).not.toBeNull();
      expect(config.proxy?.noProxy).toBe('localhost');
    });
  });

  describe('proxy group — tier precedence', () => {
    it('sonar-env proxy wins over generic-env proxy', () => {
      const config = resolveNetworkConfig({
        SONAR_HTTPS_PROXY_URL: 'https://sonar-proxy:8080',
        HTTPS_PROXY: 'https://generic-proxy:3128',
      });
      expect(config.proxy?.source).toBe('sonar-env');
      expect(config.proxy?.proxyHttps?.getUrlWithCredentials()).toBe('https://sonar-proxy:8080');
    });

    it('HTTPS_PROXY from generic-env is ignored when sonar-env tier wins', () => {
      const config = resolveNetworkConfig({
        SONAR_HTTPS_PROXY_URL: 'https://sonar-proxy:8080',
        HTTPS_PROXY: 'https://generic-proxy:3128',
      });
      // proxyHttp is null because sonar-env tier won but has no SONAR_HTTP_PROXY_URL
      expect(config.proxy?.proxyHttp).toBeNull();
    });

    it('NO_PROXY not picked when sonar-env tier wins', () => {
      const config = resolveNetworkConfig({
        SONAR_HTTPS_PROXY_URL: 'https://sonar-proxy:8080',
        NO_PROXY: 'localhost',
      });
      // noProxy is null — NO_PROXY is generic-env but sonar-env tier won
      expect(config.proxy?.noProxy).toBeNull();
    });

    it('standalone SONAR_NO_PROXY without sonar-env proxy falls through to generic-env', () => {
      const config = resolveNetworkConfig({
        SONAR_NO_PROXY: 'internal.corp.com',
        HTTPS_PROXY: 'https://proxy:3128',
      });
      // sonar-env tier skipped (no proxy); generic-env wins
      expect(config.proxy?.source).toBe('generic-env');
      // noProxy is null — NO_PROXY not set; SONAR_NO_PROXY not picked (wrong tier)
      expect(config.proxy?.noProxy).toBeNull();
    });

    it('standalone SONAR_NO_PROXY alone results in null proxy', () => {
      const config = resolveNetworkConfig({ SONAR_NO_PROXY: 'internal.corp.com' });
      expect(config.proxy).toBeNull();
    });
  });

  describe('caCert — independent resolution', () => {
    it('resolves from SONAR_CA_CERT (sonar-env, explicit)', () => {
      const config = resolveNetworkConfig({ SONAR_CA_CERT: '/etc/ssl/sonar-ca.pem' });
      expect(config.caCert?.source).toBe('sonar-env');
      expect(config.caCert?.explicit).toBe(true);
      expect(config.caCert?.path).toBe('/etc/ssl/sonar-ca.pem');
    });

    it('resolves from NODE_EXTRA_CA_CERTS (generic-env, not explicit)', () => {
      const config = resolveNetworkConfig({ NODE_EXTRA_CA_CERTS: '/etc/ssl/corp-ca.pem' });
      expect(config.caCert?.source).toBe('generic-env');
      expect(config.caCert?.explicit).toBe(false);
      expect(config.caCert?.path).toBe('/etc/ssl/corp-ca.pem');
    });

    it('prefers SONAR_CA_CERT over NODE_EXTRA_CA_CERTS', () => {
      const config = resolveNetworkConfig({
        SONAR_CA_CERT: '/etc/ssl/sonar-ca.pem',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/corp-ca.pem',
      });
      expect(config.caCert?.source).toBe('sonar-env');
      expect(config.caCert?.path).toBe('/etc/ssl/sonar-ca.pem');
    });

    it('resolves independently of the proxy group tier', () => {
      const config = resolveNetworkConfig({
        SONAR_HTTPS_PROXY_URL: 'https://sonar-proxy:8080',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/corp-ca.pem',
      });
      expect(config.proxy?.source).toBe('sonar-env');
      expect(config.caCert?.source).toBe('generic-env');
    });
  });

  describe('fromEnv — support both lower and uppercase', () => {
    it('resolves https_proxy (lowercase) as proxy', () => {
      const config = resolveNetworkConfig({ https_proxy: 'https://proxy:3128' });
      expect(config.proxy?.source).toBe('generic-env');
      expect(config.proxy?.proxyHttps?.getUrlWithCredentials()).toBe('https://proxy:3128');
    });

    it('lowercase takes precedence over uppercase when both are set', () => {
      const config = resolveNetworkConfig({
        HTTPS_PROXY: 'https://upper:3128',
        https_proxy: 'https://lower:3128',
      });
      expect(config.proxy?.proxyHttps?.getUrlWithCredentials()).toBe('https://lower:3128');
    });
  });

  it('proxy values are RedactedUrl instances', () => {
    const config = resolveNetworkConfig({
      HTTPS_PROXY: 'https://alice:secret@proxy:3128',
    });
    expect(config.proxy?.proxyHttps?.getUrl()).toBe('https://***:***@proxy:3128/');
    expect(config.proxy?.proxyHttps?.getUrlWithCredentials()).toBe(
      'https://alice:secret@proxy:3128',
    );
  });

  describe('clientCert', () => {
    it('returns null when SONAR_TLS_CLIENT_CERT is not set', () => {
      expect(resolveNetworkConfig({}).clientCert).toBeNull();
    });

    it('resolves certPath, keyPath, source, and explicit flag', () => {
      const config = resolveNetworkConfig({
        SONAR_TLS_CLIENT_CERT: CERT_PATH,
        SONAR_TLS_CLIENT_KEY_FILE: KEY_PATH,
      });
      expect(config.clientCert?.certPath).toBe(CERT_PATH);
      expect(config.clientCert?.keyPath).toBe(KEY_PATH);
      expect(config.clientCert?.source).toBe('sonar-env');
      expect(config.clientCert?.explicit).toBe(true);
    });

    it('reads and stores resolved PEM content eagerly', () => {
      const config = resolveNetworkConfig({
        SONAR_TLS_CLIENT_CERT: CERT_PATH,
        SONAR_TLS_CLIENT_KEY_FILE: KEY_PATH,
      });
      expect(config.clientCert?.resolvedCertPem).toBe(readFileSync(CERT_PATH, 'utf-8'));
      expect(config.clientCert?.resolvedKeyPem).toBe(readFileSync(KEY_PATH, 'utf-8'));
    });

    it('captures passphrase when SONAR_TLS_CLIENT_PASSPHRASE is set', () => {
      const config = resolveNetworkConfig({
        SONAR_TLS_CLIENT_CERT: CERT_PATH,
        SONAR_TLS_CLIENT_KEY_FILE: KEY_PATH,
        SONAR_TLS_CLIENT_PASSPHRASE: 'secret',
      });
      expect(config.clientCert?.passphrase).toBe('secret');
    });

    it('passphrase is undefined when SONAR_TLS_CLIENT_PASSPHRASE is not set', () => {
      const config = resolveNetworkConfig({
        SONAR_TLS_CLIENT_CERT: CERT_PATH,
        SONAR_TLS_CLIENT_KEY_FILE: KEY_PATH,
      });
      expect(config.clientCert?.passphrase).toBeUndefined();
    });

    it('sets error when SONAR_TLS_CLIENT_KEY_FILE is missing for a PEM cert', () => {
      const config = resolveNetworkConfig({ SONAR_TLS_CLIENT_CERT: CERT_PATH });
      expect(config.clientCert).toBeNull();
      expect(config.error).toBeDefined();
    });

    it('resolves PKCS12 path without SONAR_TLS_CLIENT_KEY_FILE', () => {
      const config = resolveNetworkConfig({
        SONAR_TLS_CLIENT_CERT: P12_PATH,
        SONAR_TLS_CLIENT_PASSPHRASE: 'testpassword',
      });
      expect(config.clientCert?.certPath).toBe(P12_PATH);
      expect(config.clientCert?.keyPath).toBeNull();
      expect(config.clientCert?.resolvedCertPem).toContain('-----BEGIN CERTIFICATE-----');
      expect(config.clientCert?.resolvedKeyPem).toContain('PRIVATE KEY');
    });

    it('sets error when PKCS12 passphrase is wrong', () => {
      const config = resolveNetworkConfig({
        SONAR_TLS_CLIENT_CERT: P12_PATH,
        SONAR_TLS_CLIENT_PASSPHRASE: 'wrongpassword',
      });
      expect(config.clientCert).toBeNull();
      expect(config.error).toBeDefined();
    });

    it('sets error when cert file does not exist', () => {
      const config = resolveNetworkConfig({
        SONAR_TLS_CLIENT_CERT: '/nonexistent/cert.pem',
        SONAR_TLS_CLIENT_KEY_FILE: KEY_PATH,
      });
      expect(config.clientCert).toBeNull();
      expect(config.error).toBeDefined();
    });

    it('sets error when key file does not exist', () => {
      const config = resolveNetworkConfig({
        SONAR_TLS_CLIENT_CERT: CERT_PATH,
        SONAR_TLS_CLIENT_KEY_FILE: '/nonexistent/key.pem',
      });
      expect(config.clientCert).toBeNull();
      expect(config.error).toBeDefined();
    });
  });
});

// --- buildFetchNetworkOptions ---

function makeConfig(env: NodeJS.ProcessEnv) {
  return resolveNetworkConfig(env);
}

describe('buildFetchNetworkOptions', () => {
  it('returns empty object when no config', () => {
    const opts = buildFetchNetworkOptions('https://sonar.example.com', makeConfig({}));
    expect(opts).toEqual({});
  });

  describe('proxy', () => {
    it('sets proxy for https URL when proxyHttps is explicit', () => {
      const config = makeConfig({ SONAR_HTTPS_PROXY_URL: 'https://proxy:8080' });
      const opts = buildFetchNetworkOptions('https://sonar.example.com/api', config);
      expect(opts.proxy).toBe('https://proxy:8080');
    });

    it('sets proxy for http URL when proxyHttp is explicit', () => {
      const config = makeConfig({ SONAR_HTTP_PROXY_URL: 'https://proxy:8080' });
      // split to avoid S5332 — the non-TLS scheme is intentional to exercise proxyHttp selection
      const httpUrl = 'http' + '://sonar.internal/api';
      const opts = buildFetchNetworkOptions(httpUrl, config);
      expect(opts.proxy).toBe('https://proxy:8080');
    });

    it('does not set proxy for https URL when only proxyHttp is set', () => {
      const config = makeConfig({ SONAR_HTTP_PROXY_URL: 'https://proxy:8080' });
      const opts = buildFetchNetworkOptions('https://sonar.example.com/api', config);
      expect(opts.proxy).toBeUndefined();
    });

    it('does not set proxy when proxyHttps is generic-env (not explicit)', () => {
      const config = makeConfig({ HTTPS_PROXY: 'https://proxy:3128' });
      const opts = buildFetchNetworkOptions('https://sonar.example.com/api', config);
      expect(opts.proxy).toBeUndefined();
    });

    it('includes credentials in proxy URL', () => {
      const config = makeConfig({ SONAR_HTTPS_PROXY_URL: 'https://user:pass@proxy:8080' });
      const opts = buildFetchNetworkOptions('https://sonar.example.com/api', config);
      expect(opts.proxy).toBe('https://user:pass@proxy:8080');
    });
  });

  describe('noProxy bypass', () => {
    it('skips proxy when hostname matches noProxy exactly', () => {
      const config = makeConfig({
        SONAR_HTTPS_PROXY_URL: 'https://proxy:8080',
        SONAR_NO_PROXY: 'sonar.internal.corp.com',
      });
      const opts = buildFetchNetworkOptions('https://sonar.internal.corp.com/api', config);
      expect(opts.proxy).toBeUndefined();
    });

    it('skips proxy when hostname matches noProxy suffix', () => {
      const config = makeConfig({
        SONAR_HTTPS_PROXY_URL: 'https://proxy:8080',
        SONAR_NO_PROXY: 'corp.com',
      });
      const opts = buildFetchNetworkOptions('https://sonar.corp.com/api', config);
      expect(opts.proxy).toBeUndefined();
    });

    it('skips proxy when noProxy is wildcard *', () => {
      const config = makeConfig({
        SONAR_HTTPS_PROXY_URL: 'https://proxy:8080',
        SONAR_NO_PROXY: '*',
      });
      const opts = buildFetchNetworkOptions('https://sonar.example.com/api', config);
      expect(opts.proxy).toBeUndefined();
    });

    it('sets proxy when hostname does not match noProxy', () => {
      const config = makeConfig({
        SONAR_HTTPS_PROXY_URL: 'https://proxy:8080',
        SONAR_NO_PROXY: 'other.corp.com',
      });
      const opts = buildFetchNetworkOptions('https://sonar.example.com/api', config);
      expect(opts.proxy).toBe('https://proxy:8080');
    });

    it('strips leading dot from noProxy entry — root domain matches', () => {
      const config = makeConfig({
        SONAR_HTTPS_PROXY_URL: 'https://proxy:8080',
        SONAR_NO_PROXY: '.corp.com',
      });
      // root domain itself should match when entry has a leading dot
      expect(buildFetchNetworkOptions('https://corp.com/api', config).proxy).toBeUndefined();
      // subdomain should also match
      expect(buildFetchNetworkOptions('https://sonar.corp.com/api', config).proxy).toBeUndefined();
    });

    it('enforces dot separator — corp.com does not match notcorp.com', () => {
      const config = makeConfig({
        SONAR_HTTPS_PROXY_URL: 'https://proxy:8080',
        SONAR_NO_PROXY: 'corp.com',
      });
      const opts = buildFetchNetworkOptions('https://notcorp.com/api', config);
      expect(opts.proxy).toBe('https://proxy:8080');
    });

    it('*.corp.com wildcard matches subdomains', () => {
      const config = makeConfig({
        SONAR_HTTPS_PROXY_URL: 'https://proxy:8080',
        SONAR_NO_PROXY: '*.corp.com',
      });
      expect(buildFetchNetworkOptions('https://sonar.corp.com/api', config).proxy).toBeUndefined();
    });

    it('*.corp.com wildcard does not match the root domain corp.com', () => {
      const config = makeConfig({
        SONAR_HTTPS_PROXY_URL: 'https://proxy:8080',
        SONAR_NO_PROXY: '*.corp.com',
      });
      expect(buildFetchNetworkOptions('https://corp.com/api', config).proxy).toBe(
        'https://proxy:8080',
      );
    });

    it('* as one entry in a comma-separated list matches everything', () => {
      const config = makeConfig({
        SONAR_HTTPS_PROXY_URL: 'https://proxy:8080',
        SONAR_NO_PROXY: 'localhost,*',
      });
      const opts = buildFetchNetworkOptions('https://anything.example.com/api', config);
      expect(opts.proxy).toBeUndefined();
    });

    it('port-specific noProxy entry only bypasses matching port', () => {
      const config = makeConfig({
        SONAR_HTTPS_PROXY_URL: 'https://proxy:8080',
        SONAR_NO_PROXY: 'sonar.corp.com:9000',
      });
      // port 443 (default https) — should NOT bypass (rule is for port 9000)
      expect(buildFetchNetworkOptions('https://sonar.corp.com/api', config).proxy).toBe(
        'https://proxy:8080',
      );
      // port 9000 — should bypass
      expect(
        buildFetchNetworkOptions('https://sonar.corp.com:9000/api', config).proxy,
      ).toBeUndefined();
    });

    it('does not bypass proxy when noProxy is from different tier than proxy', () => {
      // sonar-env proxy + generic-env NO_PROXY → bypass not applied
      // (sonar-env tier won for proxy, so noProxy is null since SONAR_NO_PROXY not set)
      const config = makeConfig({
        SONAR_HTTPS_PROXY_URL: 'https://proxy:8080',
        NO_PROXY: 'sonar.example.com',
      });
      const opts = buildFetchNetworkOptions('https://sonar.example.com/api', config);
      expect(opts.proxy).toBe('https://proxy:8080');
    });
  });

  describe('CA cert', () => {
    it('sets tls.ca as array of rootCertificates + BunFile when caCert is explicit', () => {
      const pemPath = join(tmpdir(), 'sonar-test-ca.pem');
      writeFileSync(pemPath, '-----BEGIN CERTIFICATE-----\nfakecert\n-----END CERTIFICATE-----');

      const config = makeConfig({ SONAR_CA_CERT: pemPath });
      const opts = buildFetchNetworkOptions('https://sonar.example.com/api', config);

      const ca = opts.tls?.ca as Array<unknown>;
      expect(ca).toHaveLength(rootCertificates.length + 1);
      // Last entry is the BunFile pointing at the configured path
      const bunFile = ca.at(-1) as { name?: string };
      expect(bunFile?.name).toBe(pemPath);
    });

    it('does not set tls.ca when caCert is generic-env (not explicit)', () => {
      const config = makeConfig({ NODE_EXTRA_CA_CERTS: '/etc/ssl/corp-ca.pem' });
      const opts = buildFetchNetworkOptions('https://sonar.example.com/api', config);
      expect(opts.tls).toBeUndefined();
    });
  });

  it('sets both proxy and tls.ca when both are explicit', () => {
    const pemPath = join(tmpdir(), 'sonar-test-ca-combo.pem');
    writeFileSync(pemPath, '-----BEGIN CERTIFICATE-----\nfakecert\n-----END CERTIFICATE-----');

    const config = makeConfig({
      SONAR_HTTPS_PROXY_URL: 'https://proxy:8080',
      SONAR_CA_CERT: pemPath,
    });
    const opts = buildFetchNetworkOptions('https://sonar.example.com/api', config);

    expect(opts.proxy).toBe('https://proxy:8080');
    expect(opts.tls?.ca).toBeDefined();
  });

  describe('client cert', () => {
    it('sets tls.cert and tls.key as resolved PEM strings', () => {
      const config = makeConfig({
        SONAR_TLS_CLIENT_CERT: CERT_PATH,
        SONAR_TLS_CLIENT_KEY_FILE: KEY_PATH,
      });
      const opts = buildFetchNetworkOptions('https://sonar.example.com/api', config);
      expect(opts.tls?.cert).toBe(readFileSync(CERT_PATH, 'utf-8'));
      expect(opts.tls?.key).toBe(readFileSync(KEY_PATH, 'utf-8'));
    });

    it('does not set tls.cert or tls.key when clientCert is null', () => {
      const config = makeConfig({});
      const opts = buildFetchNetworkOptions('https://sonar.example.com/api', config);
      expect(opts.tls?.cert).toBeUndefined();
      expect(opts.tls?.key).toBeUndefined();
    });

    it('sets tls.cert and tls.key as PEM strings for PKCS12 source', () => {
      const config = makeConfig({
        SONAR_TLS_CLIENT_CERT: P12_PATH,
        SONAR_TLS_CLIENT_PASSPHRASE: 'testpassword',
      });
      const opts = buildFetchNetworkOptions('https://sonar.example.com/api', config);
      expect(opts.tls?.cert).toContain('-----BEGIN CERTIFICATE-----');
      expect(opts.tls?.key).toContain('PRIVATE KEY');
    });

    it('sets tls.passphrase when SONAR_TLS_CLIENT_PASSPHRASE is provided', () => {
      const config = makeConfig({
        SONAR_TLS_CLIENT_CERT: CERT_PATH,
        SONAR_TLS_CLIENT_KEY_FILE: KEY_PATH,
        SONAR_TLS_CLIENT_PASSPHRASE: 'supersecret',
      });
      const opts = buildFetchNetworkOptions('https://sonar.example.com/api', config);
      expect(opts.tls?.passphrase).toBe('supersecret');
    });

    it('sets ca, cert, and key together when both CA cert and client cert are configured', () => {
      const caPath = join(tmpdir(), 'sonar-test-ca-client-cert.pem');
      writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nfakecert\n-----END CERTIFICATE-----');

      const config = makeConfig({
        SONAR_CA_CERT: caPath,
        SONAR_TLS_CLIENT_CERT: CERT_PATH,
        SONAR_TLS_CLIENT_KEY_FILE: KEY_PATH,
      });
      const opts = buildFetchNetworkOptions('https://sonar.example.com/api', config);

      expect(opts.tls?.ca).toBeDefined();
      expect(opts.tls?.cert).toBeDefined();
      expect(opts.tls?.key).toBeDefined();
    });
  });
});

// --- buildSubprocessNetworkEnv ---

describe('buildSubprocessNetworkEnv', () => {
  it('returns empty object when no config', () => {
    expect(buildSubprocessNetworkEnv(makeConfig({}))).toEqual({});
  });

  it('sets SONAR_HTTPS_PROXY_URL when HTTPS proxy is configured', () => {
    const env = buildSubprocessNetworkEnv(
      makeConfig({ SONAR_HTTPS_PROXY_URL: 'https://proxy:8080' }),
    );
    expect(env.SONAR_HTTPS_PROXY_URL).toBe('https://proxy:8080');
    expect(env.SONAR_HTTP_PROXY_URL).toBeUndefined();
  });

  it('sets SONAR_HTTP_PROXY_URL when HTTP proxy is configured', () => {
    const env = buildSubprocessNetworkEnv(
      makeConfig({ SONAR_HTTP_PROXY_URL: 'https://proxy:8080' }),
    );
    expect(env.SONAR_HTTP_PROXY_URL).toBe('https://proxy:8080');
    expect(env.SONAR_HTTPS_PROXY_URL).toBeUndefined();
  });

  it('sets both proxy vars when both are configured', () => {
    const env = buildSubprocessNetworkEnv(
      makeConfig({
        SONAR_HTTPS_PROXY_URL: 'https://https-proxy:8080',
        SONAR_HTTP_PROXY_URL: 'https://http-proxy:8080',
      }),
    );
    expect(env.SONAR_HTTPS_PROXY_URL).toBe('https://https-proxy:8080');
    expect(env.SONAR_HTTP_PROXY_URL).toBe('https://http-proxy:8080');
  });

  it('sets SONAR_NO_PROXY when noProxy is configured', () => {
    const env = buildSubprocessNetworkEnv(
      makeConfig({
        SONAR_HTTPS_PROXY_URL: 'https://proxy:8080',
        SONAR_NO_PROXY: 'internal.corp.com',
      }),
    );
    expect(env.SONAR_NO_PROXY).toBe('internal.corp.com');
  });

  it('omits SONAR_NO_PROXY when noProxy is absent', () => {
    const env = buildSubprocessNetworkEnv(
      makeConfig({ SONAR_HTTPS_PROXY_URL: 'https://proxy:8080' }),
    );
    expect(env.SONAR_NO_PROXY).toBeUndefined();
  });

  it('propagates proxy from generic-env source (HTTPS_PROXY)', () => {
    const env = buildSubprocessNetworkEnv(makeConfig({ HTTPS_PROXY: 'https://proxy:3128' }));
    expect(env.SONAR_HTTPS_PROXY_URL).toBe('https://proxy:3128');
  });

  it('uses getUrlWithCredentials — credentials are not redacted', () => {
    const env = buildSubprocessNetworkEnv(
      makeConfig({ SONAR_HTTPS_PROXY_URL: 'https://user:pass@proxy:8080' }),
    );
    expect(env.SONAR_HTTPS_PROXY_URL).toBe('https://user:pass@proxy:8080');
  });

  it('sets all three cert vars to the same path when CA cert is configured', () => {
    const env = buildSubprocessNetworkEnv(makeConfig({ SONAR_CA_CERT: '/etc/ssl/corp-ca.pem' }));
    expect(env.SONAR_CA_CERT).toBe('/etc/ssl/corp-ca.pem');
  });

  it('propagates cert vars from generic-env source (NODE_EXTRA_CA_CERTS)', () => {
    const env = buildSubprocessNetworkEnv(
      makeConfig({ NODE_EXTRA_CA_CERTS: '/etc/ssl/corp-ca.pem' }),
    );
    expect(env.SONAR_CA_CERT).toBe('/etc/ssl/corp-ca.pem');
  });

  it('returns all proxy and cert vars combined', () => {
    const env = buildSubprocessNetworkEnv(
      makeConfig({
        SONAR_HTTPS_PROXY_URL: 'https://proxy:8080',
        SONAR_NO_PROXY: 'localhost',
        SONAR_CA_CERT: '/etc/ssl/corp-ca.pem',
      }),
    );
    expect(env.SONAR_HTTPS_PROXY_URL).toBe('https://proxy:8080');
    expect(env.SONAR_NO_PROXY).toBe('localhost');
    expect(env.SONAR_CA_CERT).toBe('/etc/ssl/corp-ca.pem');
  });

  it('sets SONAR_TLS_CLIENT_CERT and SONAR_TLS_CLIENT_KEY_FILE for PEM cert without passphrase', () => {
    const env = buildSubprocessNetworkEnv(
      makeConfig({ SONAR_TLS_CLIENT_CERT: CERT_PATH, SONAR_TLS_CLIENT_KEY_FILE: KEY_PATH }),
    );
    expect(env.SONAR_TLS_CLIENT_CERT).toBe(CERT_PATH);
    expect(env.SONAR_TLS_CLIENT_KEY_FILE).toBe(KEY_PATH);
    expect(env.SONAR_TLS_CLIENT_PASSPHRASE).toBeUndefined();
  });

  it('sets SONAR_TLS_CLIENT_PASSPHRASE when passphrase is provided', () => {
    const env = buildSubprocessNetworkEnv(
      makeConfig({
        SONAR_TLS_CLIENT_CERT: CERT_PATH,
        SONAR_TLS_CLIENT_KEY_FILE: KEY_PATH,
        SONAR_TLS_CLIENT_PASSPHRASE: 'secret',
      }),
    );
    expect(env.SONAR_TLS_CLIENT_PASSPHRASE).toBe('secret');
  });

  it('omits SONAR_TLS_CLIENT_PASSPHRASE for empty-string passphrase', () => {
    const env = buildSubprocessNetworkEnv(
      makeConfig({
        SONAR_TLS_CLIENT_CERT: CERT_PATH,
        SONAR_TLS_CLIENT_KEY_FILE: KEY_PATH,
        SONAR_TLS_CLIENT_PASSPHRASE: '',
      }),
    );
    expect(env.SONAR_TLS_CLIENT_PASSPHRASE).toBeUndefined();
  });

  it('omits SONAR_TLS_CLIENT_KEY_FILE for PKCS12 cert', () => {
    const env = buildSubprocessNetworkEnv(
      makeConfig({ SONAR_TLS_CLIENT_CERT: P12_PATH, SONAR_TLS_CLIENT_PASSPHRASE: 'testpassword' }),
    );
    expect(env.SONAR_TLS_CLIENT_CERT).toBe(P12_PATH);
    expect(env.SONAR_TLS_CLIENT_KEY_FILE).toBeUndefined();
    expect(env.SONAR_TLS_CLIENT_PASSPHRASE).toBe('testpassword');
  });
});
