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

import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';

import { isPkcs12Path, pkcs12ToPem } from '../crypto/pkcs12';
import { NetworkConfigError } from '../errors';
import { createRedactedUrl } from '../redacted-url';
import type {
  CaCertConfig,
  ClientCertConfig,
  ConfigSource,
  FetchNetworkOptions,
  ProxyGroup,
  ResolvedNetworkConfig,
  SourcedValue,
  TlsConfig,
} from './types';

// --- Proxy group ---
// proxyHttps, proxyHttp, and noProxy are resolved as a unit: the highest-priority
// entry in PROXY_CONFIGS that has at least one proxy value wins, and all three
// fields come from it. A standalone noProxy entry cannot elevate an entry on its own.

type EnvLookup = (env: NodeJS.ProcessEnv, varName: string) => string | undefined;

interface ProxyEnvVars {
  httpsVar: string;
  httpVar: string;
  noProxyVar: string;
  lookup: EnvLookup;
}

/** Reads an env var preferring the lowercase form, then falling back to the exact name. */
function getCaseVariantEnv(env: NodeJS.ProcessEnv, varName: string): string | undefined {
  return env[varName.toLowerCase()] ?? env[varName];
}

const PROXY_CONFIGS: Array<SourcedValue<ProxyEnvVars>> = [
  {
    value: {
      httpsVar: 'SONAR_HTTPS_PROXY_URL',
      httpVar: 'SONAR_HTTP_PROXY_URL',
      noProxyVar: 'SONAR_NO_PROXY',
      lookup: (env, name) => env[name],
    },
    source: 'sonar-env',
    explicit: true,
  },
  // stored-config slot added here when sonar config is wired
  {
    value: {
      httpsVar: 'HTTPS_PROXY',
      httpVar: 'HTTP_PROXY',
      noProxyVar: 'NO_PROXY',
      lookup: getCaseVariantEnv,
    },
    source: 'generic-env',
    explicit: false,
  },
];

function resolveProxyGroup(env: NodeJS.ProcessEnv): ProxyGroup | null {
  for (const {
    value: { httpsVar, httpVar, noProxyVar, lookup },
    source,
    explicit,
  } of PROXY_CONFIGS) {
    const httpsVal = lookup(env, httpsVar);
    const httpVal = lookup(env, httpVar);
    if (!httpsVal && !httpVal) {
      continue;
    }

    return {
      source,
      explicit,
      proxyHttps: httpsVal ? createRedactedUrl(httpsVal) : null,
      proxyHttp: httpVal ? createRedactedUrl(httpVal) : null,
      noProxy: lookup(env, noProxyVar) ?? null,
    };
  }
  return null;
}

// --- CA cert (resolves independently) ---

function resolveCaCert(env: NodeJS.ProcessEnv): CaCertConfig | null {
  const resolved =
    fromEnv(env, 'SONAR_CA_CERT', 'sonar-env') ??
    // stored-config slot added here when sonar config is wired
    fromEnv(env, 'NODE_EXTRA_CA_CERTS', 'generic-env');
  if (!resolved) {
    return null;
  }
  return {
    source: resolved.source,
    explicit: resolved.explicit,
    path: resolved.value,
  };
}

function fromEnv(
  env: NodeJS.ProcessEnv,
  varName: string,
  source: ConfigSource,
): SourcedValue<string> | null {
  const val = env[varName];
  return val ? { value: val, source, explicit: source !== 'generic-env' } : null;
}

// --- Client cert (sonar-env only, no generic-env fallback) ---

function readClientCertFile(filePath: string, label: string): Buffer;
function readClientCertFile(filePath: string, label: string, encoding: BufferEncoding): string;
function readClientCertFile(
  filePath: string,
  label: string,
  encoding?: BufferEncoding,
): Buffer | string {
  try {
    return readFileSync(filePath, encoding);
  } catch (err) {
    throw new NetworkConfigError(
      `Failed to read ${label} "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

function resolveClientCert(env: NodeJS.ProcessEnv): ClientCertConfig | null {
  const certPath = env.SONAR_TLS_CLIENT_CERT;
  if (!certPath) {
    return null;
  }

  const passphrase = env.SONAR_TLS_CLIENT_PASSPHRASE;

  if (isPkcs12Path(certPath)) {
    const p12Buffer = readClientCertFile(certPath, 'client certificate');
    const { cert: resolvedCertPem, key: resolvedKeyPem } = pkcs12ToPem(p12Buffer, passphrase);
    return {
      source: 'sonar-env',
      explicit: true,
      format: 'pkcs12',
      certPath,
      keyPath: null,
      passphrase,
      resolvedCertPem,
      resolvedKeyPem,
    };
  }

  const keyPath = env.SONAR_TLS_CLIENT_KEY_FILE;
  if (!keyPath) {
    throw new NetworkConfigError(
      'SONAR_TLS_CLIENT_KEY_FILE is required when SONAR_TLS_CLIENT_CERT is not a .p12 or .pfx file',
    );
  }

  return {
    source: 'sonar-env',
    explicit: true,
    format: 'pem',
    certPath,
    keyPath,
    passphrase,
    resolvedCertPem: readClientCertFile(certPath, 'client certificate', 'utf-8'),
    resolvedKeyPem: readClientCertFile(keyPath, 'client certificate key', 'utf-8'),
  };
}

// --- Resolver ---

export function resolveNetworkConfig(env: NodeJS.ProcessEnv = process.env): ResolvedNetworkConfig {
  const proxy = resolveProxyGroup(env);
  const caCert = resolveCaCert(env);
  let clientCert: ClientCertConfig | null = null;
  let error: string | undefined;
  try {
    clientCert = resolveClientCert(env);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return { proxy, caCert, clientCert, error };
}

// --- Singleton ---

let cachedConfig: ResolvedNetworkConfig | undefined;

export function getNetworkConfig(): ResolvedNetworkConfig {
  cachedConfig ??= resolveNetworkConfig();
  return cachedConfig;
}

export function getNetworkConfigOrThrow(): ResolvedNetworkConfig {
  const config = getNetworkConfig();
  if (config.error !== undefined) {
    throw new NetworkConfigError(config.error);
  }
  return config;
}

/** Test seam — resets the cached singleton. */
export function clearNetworkConfigCache(): void {
  cachedConfig = undefined;
}

const DEFAULT_PORT_HTTPS = 443;
const DEFAULT_PORT_HTTP = 80;

// --- Subprocess env builder ---

/**
 * Builds env vars to inject into subprocess invocations (sonar-secrets, sca-scanner-cli, CAG).
 * Translates the resolved network config into all known env var names each binary may read,
 * regardless of which source (sonar-env, stored-config, generic-env) the config came from.
 */
export function buildSubprocessNetworkEnv(
  config: ResolvedNetworkConfig = getNetworkConfig(),
): Record<string, string> {
  const env: Record<string, string> = {};

  if (config.proxy?.proxyHttps) {
    env.SONAR_HTTPS_PROXY_URL = config.proxy.proxyHttps.getUrlWithCredentials();
  }
  if (config.proxy?.proxyHttp) {
    env.SONAR_HTTP_PROXY_URL = config.proxy.proxyHttp.getUrlWithCredentials();
  }
  if (config.proxy?.noProxy) {
    env.SONAR_NO_PROXY = config.proxy.noProxy;
  }

  if (config.caCert) {
    env.SONAR_CA_CERT = config.caCert.path;
    env.SONAR_SECRETS_AUTH_CERT_FILE = config.caCert.path; // sonar-secrets
  }

  if (config.clientCert) {
    env.SONAR_TLS_CLIENT_CERT = config.clientCert.certPath;
    if (config.clientCert.keyPath !== null) {
      env.SONAR_TLS_CLIENT_KEY_FILE = config.clientCert.keyPath;
    }
    if (config.clientCert.passphrase) {
      env.SONAR_TLS_CLIENT_PASSPHRASE = config.clientCert.passphrase;
    }
  }

  return env;
}

// --- Fetch options builder ---

export function buildFetchNetworkOptions(
  url: string,
  config: ResolvedNetworkConfig = getNetworkConfigOrThrow(),
): FetchNetworkOptions {
  return {
    ...buildProxyOption(url, config),
    ...buildTlsOption(config),
  };
}

function buildProxyOption(
  url: string,
  config: ResolvedNetworkConfig,
): { proxy: string } | Record<string, never> {
  if (!config.proxy?.explicit) {
    return {};
  }
  const parsed = tryParseUrl(url);
  if (!parsed) {
    return {};
  }
  const proxyCandidate =
    parsed.protocol === 'https:' ? config.proxy.proxyHttps : config.proxy.proxyHttp;
  if (!proxyCandidate) {
    return {};
  }
  const defaultPort = parsed.protocol === 'https:' ? DEFAULT_PORT_HTTPS : DEFAULT_PORT_HTTP;
  const port = Number.parseInt(parsed.port) || defaultPort;
  const bypass =
    config.proxy.noProxy !== null && matchesNoProxy(parsed.hostname, port, config.proxy.noProxy);
  return bypass ? {} : { proxy: proxyCandidate.getUrlWithCredentials() };
}

function buildTlsOption(config: ResolvedNetworkConfig) {
  if (!config.caCert?.explicit && !config.clientCert?.explicit) {
    return {};
  }

  const tls: TlsConfig = {};

  if (config.caCert?.explicit) {
    tls.ca = [...rootCertificates, Bun.file(config.caCert.path)];
  }

  if (config.clientCert?.explicit) {
    tls.cert = config.clientCert.resolvedCertPem;
    tls.key = config.clientCert.resolvedKeyPem;
    tls.passphrase = config.clientCert.passphrase;
  }

  return { tls };
}

function tryParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function matchesNoProxy(hostname: string, port: number, noProxy: string): boolean {
  const h = hostname.toLowerCase();
  if (noProxy.toLowerCase() === '*') {
    return true;
  }
  return noProxy
    .toLowerCase()
    .split(/[,\s]/)
    .filter((entry) => entry.length > 0)
    .some((entry) => {
      const parsed = parseNoProxyEntry(entry);
      if (parsed.port && parsed.port !== port) {
        return false;
      }
      return hostnameMatchesPattern(h, normalizeHostPattern(parsed.host));
    });
}

function parseNoProxyEntry(entry: string): { host: string; port: number } {
  const withPort = /^(.+):(\d+)$/.exec(entry);
  return {
    host: (withPort ? withPort[1] : entry).toLowerCase(),
    port: withPort ? Number.parseInt(withPort[2]) : 0,
  };
}

function normalizeHostPattern(host: string): string {
  if (host.startsWith('*')) {
    // Strip only the wildcard, keep the leading dot so hostnameMatchesPattern
    // can apply suffix-only matching (*.corp.com must not match corp.com itself).
    return host.slice(1);
  }
  if (host.startsWith('.')) {
    return host.slice(1);
  }
  return host;
}

function hostnameMatchesPattern(hostname: string, pattern: string): boolean {
  if (!pattern) {
    return true; // bare * → match everything
  }
  if (pattern.startsWith('.')) {
    // Retained dot from *.corp.com normalization → suffix-only, no exact match
    return hostname.endsWith(pattern);
  }
  return hostname === pattern || hostname.endsWith(`.${pattern}`);
}
