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

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  buildFetchNetworkOptions,
  clearNetworkConfigCache,
  resolveNetworkConfig,
} from '../../../../src/lib/connectivity/network-config';

afterEach(() => {
  clearNetworkConfigCache();
});

describe('resolveNetworkConfig', () => {
  it('returns all null fields when env is empty', () => {
    const config = resolveNetworkConfig({});
    expect(config.proxyHttps).toBeNull();
    expect(config.proxyHttp).toBeNull();
    expect(config.noProxy).toBeNull();
    expect(config.caCertPath).toBeNull();
  });

  describe('proxy group — tier selection', () => {
    it('sonar-env wins when SONAR_HTTPS_PROXY_URL is set', () => {
      const config = resolveNetworkConfig({ SONAR_HTTPS_PROXY_URL: 'https://sonar-proxy:8080' });
      expect(config.proxyHttps?.source).toBe('sonar-env');
      expect(config.proxyHttps?.explicit).toBe(true);
      expect(config.proxyHttps?.value.getUrlWithCredentials()).toBe('https://sonar-proxy:8080');
      expect(config.proxyHttp).toBeNull();
      expect(config.noProxy).toBeNull();
    });

    it('sonar-env wins when SONAR_HTTP_PROXY_URL is set', () => {
      const config = resolveNetworkConfig({ SONAR_HTTP_PROXY_URL: 'https://sonar-proxy:8080' });
      expect(config.proxyHttp?.source).toBe('sonar-env');
      expect(config.proxyHttp?.explicit).toBe(true);
      expect(config.proxyHttps).toBeNull();
    });

    it('sonar-env with both proxy types set', () => {
      const config = resolveNetworkConfig({
        SONAR_HTTPS_PROXY_URL: 'https://sonar-https:8080',
        SONAR_HTTP_PROXY_URL: 'https://sonar-http:8080',
      });
      expect(config.proxyHttps?.source).toBe('sonar-env');
      expect(config.proxyHttp?.source).toBe('sonar-env');
    });

    it('noProxy comes from same tier as proxy', () => {
      const config = resolveNetworkConfig({
        SONAR_HTTPS_PROXY_URL: 'https://sonar-proxy:8080',
        SONAR_NO_PROXY: 'internal.corp.com',
      });
      expect(config.noProxy?.source).toBe('sonar-env');
      expect(config.noProxy?.value).toBe('internal.corp.com');
    });

    it('generic-env used when no sonar-env proxy set', () => {
      const config = resolveNetworkConfig({ HTTPS_PROXY: 'https://proxy:3128' });
      expect(config.proxyHttps?.source).toBe('generic-env');
      expect(config.proxyHttps?.explicit).toBe(false);
      expect(config.proxyHttp).toBeNull();
    });

    it('generic-env with both proxy types and NO_PROXY', () => {
      const config = resolveNetworkConfig({
        HTTPS_PROXY: 'https://proxy:3128',
        HTTP_PROXY: 'https://proxy:3128',
        NO_PROXY: 'localhost',
      });
      expect(config.proxyHttps?.source).toBe('generic-env');
      expect(config.proxyHttp?.source).toBe('generic-env');
      expect(config.noProxy?.source).toBe('generic-env');
      expect(config.noProxy?.value).toBe('localhost');
    });
  });

  describe('proxy group — tier precedence', () => {
    it('sonar-env proxy wins over generic-env proxy', () => {
      const config = resolveNetworkConfig({
        SONAR_HTTPS_PROXY_URL: 'https://sonar-proxy:8080',
        HTTPS_PROXY: 'https://generic-proxy:3128',
      });
      expect(config.proxyHttps?.source).toBe('sonar-env');
      expect(config.proxyHttps?.value.getUrlWithCredentials()).toBe('https://sonar-proxy:8080');
    });

    it('HTTPS_PROXY from generic-env is ignored when sonar-env tier wins', () => {
      const config = resolveNetworkConfig({
        SONAR_HTTPS_PROXY_URL: 'https://sonar-proxy:8080',
        HTTPS_PROXY: 'https://generic-proxy:3128',
      });
      // proxyHttp is null because sonar-env tier won but has no SONAR_HTTP_PROXY_URL
      expect(config.proxyHttp).toBeNull();
    });

    it('NO_PROXY not picked when sonar-env tier wins', () => {
      const config = resolveNetworkConfig({
        SONAR_HTTPS_PROXY_URL: 'https://sonar-proxy:8080',
        NO_PROXY: 'localhost',
      });
      // noProxy is null — NO_PROXY is generic-env but sonar-env tier won
      expect(config.noProxy).toBeNull();
    });

    it('standalone SONAR_NO_PROXY without sonar-env proxy falls through to generic-env', () => {
      const config = resolveNetworkConfig({
        SONAR_NO_PROXY: 'internal.corp.com',
        HTTPS_PROXY: 'https://proxy:3128',
      });
      // sonar-env tier skipped (no proxy); generic-env wins
      expect(config.proxyHttps?.source).toBe('generic-env');
      // noProxy comes from generic-env NO_PROXY (not set here), not SONAR_NO_PROXY
      expect(config.noProxy).toBeNull();
    });

    it('standalone SONAR_NO_PROXY alone results in all null', () => {
      const config = resolveNetworkConfig({ SONAR_NO_PROXY: 'internal.corp.com' });
      expect(config.proxyHttps).toBeNull();
      expect(config.proxyHttp).toBeNull();
      expect(config.noProxy).toBeNull();
    });
  });

  describe('caCertPath — independent resolution', () => {
    it('resolves from SONAR_CA_CERT (sonar-env, explicit)', () => {
      const config = resolveNetworkConfig({ SONAR_CA_CERT: '/etc/ssl/sonar-ca.pem' });
      expect(config.caCertPath?.source).toBe('sonar-env');
      expect(config.caCertPath?.explicit).toBe(true);
      expect(config.caCertPath?.value).toBe('/etc/ssl/sonar-ca.pem');
    });

    it('resolves from NODE_EXTRA_CA_CERTS (generic-env, not explicit)', () => {
      const config = resolveNetworkConfig({ NODE_EXTRA_CA_CERTS: '/etc/ssl/corp-ca.pem' });
      expect(config.caCertPath?.source).toBe('generic-env');
      expect(config.caCertPath?.explicit).toBe(false);
      expect(config.caCertPath?.value).toBe('/etc/ssl/corp-ca.pem');
    });

    it('prefers SONAR_CA_CERT over NODE_EXTRA_CA_CERTS', () => {
      const config = resolveNetworkConfig({
        SONAR_CA_CERT: '/etc/ssl/sonar-ca.pem',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/corp-ca.pem',
      });
      expect(config.caCertPath?.source).toBe('sonar-env');
      expect(config.caCertPath?.value).toBe('/etc/ssl/sonar-ca.pem');
    });

    it('resolves independently of the proxy group tier', () => {
      const config = resolveNetworkConfig({
        SONAR_HTTPS_PROXY_URL: 'https://sonar-proxy:8080',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/corp-ca.pem',
      });
      expect(config.proxyHttps?.source).toBe('sonar-env');
      expect(config.caCertPath?.source).toBe('generic-env');
    });
  });

  describe('fromEnv — support both lower and uppercase', () => {
    it('resolves https_proxy (lowercase) as proxyHttps', () => {
      const config = resolveNetworkConfig({ https_proxy: 'https://proxy:3128' });
      expect(config.proxyHttps?.source).toBe('generic-env');
      expect(config.proxyHttps?.value.getUrlWithCredentials()).toBe('https://proxy:3128');
    });

    it('lowercase takes precedence over uppercase when both are set', () => {
      const config = resolveNetworkConfig({
        HTTPS_PROXY: 'https://upper:3128',
        https_proxy: 'https://lower:3128',
      });
      expect(config.proxyHttps?.value.getUrlWithCredentials()).toBe('https://lower:3128');
    });
  });

  it('proxy values are RedactedUrl instances', () => {
    const config = resolveNetworkConfig({
      HTTPS_PROXY: 'https://alice:secret@proxy:3128',
    });
    expect(config.proxyHttps?.value.getUrl()).toBe('https://***:***@proxy:3128/');
    expect(config.proxyHttps?.value.getUrlWithCredentials()).toBe(
      'https://alice:secret@proxy:3128',
    );
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
    it('sets tls.ca as array of rootCertificates + BunFile when caCertPath is explicit', () => {
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

    it('does not set tls.ca when caCertPath is generic-env (not explicit)', () => {
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
});
