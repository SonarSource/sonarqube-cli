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

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { getNetworkConfig } from '@/core/host/connectivity/network-config.ts';
import type {
  ClientCertConfig,
  ProxyGroup,
  ResolvedNetworkConfig,
} from '@/core/host/connectivity/types.ts';
import { pemToPkcs12 } from '@/core/host/crypto/pkcs12.ts';

import {
  ANTIGRAVITY_GLOBAL_MCP_CONFIG_JSON,
  CLI_COMMAND_NAME,
  CLI_TMP_DIR,
  ENV_SONAR_USER_HOME,
  getSonarUserHome,
  SONARQUBE_MCP_DOCKER_IMAGE_NAME,
} from '../../config-constants.ts';
import { normalizePath } from '../../io/fs-utils.ts';
import type { ContainerRuntime, ContainerRuntimeDetection } from '../environment/tool-detector.ts';
import type { RedactedUrl } from '../redacted-url.ts';

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpContainerCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}
export interface McpServerOptions {
  debug?: boolean;
  readOnly?: boolean;
  toolsets?: string;
}

export type McpServerContext =
  | { withFsMount: false; projectKey?: string }
  | {
      withFsMount: true;
      projectRoot: string;
      projectKey?: string;
    };

function mcpServerEnv(): Record<string, string> | undefined {
  const customHome = process.env[ENV_SONAR_USER_HOME];
  if (customHome === undefined || customHome.trim() === '') {
    return undefined;
  }
  return { [ENV_SONAR_USER_HOME]: getSonarUserHome() };
}

export function getMcpConfig(
  context: McpServerContext,
  options: McpServerOptions = {},
): McpServerConfig {
  const args = ['run', 'mcp'];

  if (context.projectKey) {
    args.push('--project', context.projectKey);
  }

  if (options.debug) {
    args.push('--debug');
  }

  if (options.readOnly) {
    args.push('--read-only');
  }

  if (options.toolsets) {
    args.push('--toolsets', options.toolsets);
  }

  const env = mcpServerEnv();
  return env === undefined
    ? { command: CLI_COMMAND_NAME, args }
    : { command: CLI_COMMAND_NAME, args, env };
}

// Path where update-ca-certificates picks up custom CA certs inside the MCP container (Debian/Alpine convention).
export const MCP_CONTAINER_CA_CERT_PATH = '/usr/local/share/ca-certificates/sonar-ca.crt';

// Fixed mount path for the client certificate PKCS12 keystore inside the MCP container.
export const MCP_CONTAINER_CLIENT_CERT_PATH = '/etc/ssl/mcp/client.p12';

// All MCP toolsets supported by the server, excluding 'cag'/'vortex' which are available
// directly via the CLI's own Vortex analysis. Passed explicitly to avoid relying on MCP-side defaults.
export const MCP_DEFAULT_TOOLSETS =
  'issues,projects,quality-gates,rules,duplications,measures,security-hotspots,dependency-risks,coverage,ide';

function toJavaNonProxyHosts(noProxy: string): string {
  return noProxy
    .split(/[,\s]+/)
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith('.') ? `*${entry}` : entry))
    .join('|');
}

function proxyJavaProps(proxyUrl: RedactedUrl, scheme: 'http' | 'https'): string[] {
  const url = new URL(proxyUrl.getUrlWithCredentials());
  const parts = [`-D${scheme}.proxyHost=${url.hostname}`];
  if (url.port) {
    parts.push(`-D${scheme}.proxyPort=${url.port}`);
  }
  if (url.username) {
    parts.push(`-D${scheme}.proxyUser=${decodeURIComponent(url.username)}`);
  }
  if (url.password) {
    parts.push(`-D${scheme}.proxyPassword=${decodeURIComponent(url.password)}`);
  }
  return parts;
}

function collectProxyJavaOpts(proxy: ProxyGroup): string[] {
  const parts: string[] = [];

  if (proxy.proxyHttps) {
    parts.push(...proxyJavaProps(proxy.proxyHttps, 'https'));
  }

  if (proxy.proxyHttp) {
    parts.push(...proxyJavaProps(proxy.proxyHttp, 'http'));
  }

  if (proxy.noProxy) {
    // Java uses it for both HTTP and HTTPS.
    parts.push(`-Dhttp.nonProxyHosts=${toJavaNonProxyHosts(proxy.noProxy)}`);
  }

  return parts;
}

interface ClientCertMount {
  hostCertPath: string;
  keystorePassphrase: string | undefined;
}

export function clientCertCachePath(clientCert: ClientCertConfig): string {
  const certHash = createHash('sha256')
    .update(clientCert.resolvedCertPem)
    .digest('hex')
    .slice(0, 16);
  return join(CLI_TMP_DIR, `mcp-client-cert-${certHash}.p12`);
}

const DOCKER_READABLE = 0o644;
const NON_TRAVERSABLE = 0o700;

function resolveClientCertMount(clientCert: ClientCertConfig): ClientCertMount {
  if (clientCert.format === 'pkcs12') {
    return {
      hostCertPath: normalizePath(clientCert.certPath),
      keystorePassphrase: clientCert.passphrase,
    };
  }
  const cachedPath = clientCertCachePath(clientCert);
  const cacheDir = dirname(cachedPath);
  mkdirSync(cacheDir, { recursive: true, mode: NON_TRAVERSABLE }); // make the directory non-traversable
  if (!existsSync(cachedPath)) {
    const pkcs12Buffer = pemToPkcs12(
      clientCert.resolvedCertPem,
      clientCert.resolvedKeyPem,
      clientCert.passphrase,
    );
    writeFileSync(cachedPath, pkcs12Buffer);
    chmodSync(cachedPath, DOCKER_READABLE); // ensure Docker container (different UID) can read the file
  }
  return {
    hostCertPath: normalizePath(cachedPath),
    keystorePassphrase: undefined,
  };
}

function collectClientCertJavaOpts(passphrase: string | undefined): string[] {
  const parts = [
    `-Djavax.net.ssl.keyStore=${MCP_CONTAINER_CLIENT_CERT_PATH}`,
    '-Djavax.net.ssl.keyStoreType=PKCS12',
  ];
  if (passphrase) {
    parts.push(`-Djavax.net.ssl.keyStorePassword=${passphrase}`);
  }
  return parts;
}

function buildDockerRunArgsAndEnv(
  auth: ResolvedAuth,
  context: McpServerContext,
  mountSource: string | undefined,
  options: McpServerOptions = {},
  network: ResolvedNetworkConfig = getNetworkConfig(),
  certMountSources: { caCert?: string; clientCert?: string } = {},
): { args: string[]; env: Record<string, string> } {
  const { token, orgKey: org, serverUrl } = auth;

  const args = [
    'run',
    '--init',
    '--pull=always',
    '-i',
    '--rm',
    '-e',
    'SONARQUBE_TOKEN',
    '-e',
    'SONARQUBE_URL',
  ];
  const env: Record<string, string> = { SONARQUBE_TOKEN: token, SONARQUBE_URL: serverUrl };

  if (auth.connectionType === 'cloud') {
    args.push('-e', 'SONARQUBE_ORG');
    env.SONARQUBE_ORG = org ?? '';
  }

  if (context.projectKey) {
    args.push('-e', 'SONARQUBE_PROJECT_KEY');
    env.SONARQUBE_PROJECT_KEY = context.projectKey;
  }

  if (mountSource) {
    args.push('-v', `${mountSource}:/app/mcp-workspace:ro`);
  }

  if (options.debug) {
    args.push('-e', 'SONARQUBE_DEBUG_ENABLED');
    env.SONARQUBE_DEBUG_ENABLED = 'true';
  }

  if (options.readOnly) {
    args.push('-e', 'SONARQUBE_READ_ONLY');
    env.SONARQUBE_READ_ONLY = 'true';
  }

  const toolsets = options.toolsets ?? MCP_DEFAULT_TOOLSETS;
  args.push('-e', 'SONARQUBE_TOOLSETS');
  env.SONARQUBE_TOOLSETS = toolsets;

  const javaOpts: string[] = [];

  if (network.proxy) {
    javaOpts.push(...collectProxyJavaOpts(network.proxy));
  }

  if (network.caCert) {
    const hostPath = certMountSources.caCert ?? normalizePath(network.caCert.path);
    args.push('-v', `${hostPath}:${MCP_CONTAINER_CA_CERT_PATH}:ro`);
  }

  if (network.clientCert) {
    const { hostCertPath, keystorePassphrase } = resolveClientCertMount(network.clientCert);
    const mountPath = certMountSources.clientCert ?? hostCertPath;
    args.push('-v', `${mountPath}:${MCP_CONTAINER_CLIENT_CERT_PATH}:ro`);
    javaOpts.push(...collectClientCertJavaOpts(keystorePassphrase));
  }

  if (javaOpts.length > 0) {
    args.push('-e', 'JAVA_OPTS');
    env.JAVA_OPTS = javaOpts.join(' ');
  }

  args.push(SONARQUBE_MCP_DOCKER_IMAGE_NAME);

  return { args, env };
}

export function getMcpContainerCommand(
  auth: ResolvedAuth,
  runtime: ContainerRuntime,
  context: McpServerContext,
  options: McpServerOptions = {},
  network: ResolvedNetworkConfig = getNetworkConfig(),
): McpContainerCommand {
  const mountSource = context.withFsMount ? normalizePath(context.projectRoot) : undefined;
  const { args, env } = buildDockerRunArgsAndEnv(auth, context, mountSource, options, network);
  return { command: runtime, args, env };
}

const WSL_HOST_PATH_ENV_VAR = 'SONARQUBE_MCP_HOST_PATH';
const WSL_CA_PATH_ENV_VAR = 'SONARQUBE_MCP_CA_PATH';
const WSL_CLIENT_CERT_PATH_ENV_VAR = 'SONARQUBE_MCP_CLIENT_CERT_PATH';

function getMcpWslContainerCommand(
  auth: ResolvedAuth,
  runtime: ContainerRuntime,
  context: McpServerContext,
  options: McpServerOptions = {},
  network: ResolvedNetworkConfig = getNetworkConfig(),
): McpContainerCommand {
  const mountSource = context.withFsMount ? `"$${WSL_HOST_PATH_ENV_VAR}"` : undefined;

  // Cert host paths must be routed through WSLENV /p-translated env vars so WSL can
  // convert Windows paths (C:/...) to WSL mount paths (/mnt/c/...) before Docker sees them.
  // Mirroring the workspace mount pattern: store the Windows path in an env var and reference
  // it as "$VAR" (quoted to handle spaces) in the docker run args.
  const certMountSources: { caCert?: string; clientCert?: string } = {};
  const wslPathEnv: Record<string, string> = {};

  if (network.caCert) {
    certMountSources.caCert = `"$${WSL_CA_PATH_ENV_VAR}"`;
    wslPathEnv[WSL_CA_PATH_ENV_VAR] = normalizePath(network.caCert.path);
  }

  if (network.clientCert) {
    const hostPath =
      network.clientCert.format === 'pkcs12'
        ? normalizePath(network.clientCert.certPath)
        : normalizePath(clientCertCachePath(network.clientCert));
    certMountSources.clientCert = `"$${WSL_CLIENT_CERT_PATH_ENV_VAR}"`;
    wslPathEnv[WSL_CLIENT_CERT_PATH_ENV_VAR] = hostPath;
  }

  const { args, env } = buildDockerRunArgsAndEnv(
    auth,
    context,
    mountSource,
    options,
    network,
    certMountSources,
  );

  const wslenv = Object.keys(env).map((name) => `${name}/u`);

  if (context.withFsMount) {
    env[WSL_HOST_PATH_ENV_VAR] = context.projectRoot;
    wslenv.push(`${WSL_HOST_PATH_ENV_VAR}/p`);
  }

  for (const [key, value] of Object.entries(wslPathEnv)) {
    env[key] = value;
    wslenv.push(`${key}/p`);
  }

  env.WSLENV = wslenv.join(':');

  return { command: 'wsl.exe', args: ['sh', '-c', [runtime, ...args].join(' ')], env };
}

export function resolveMcpContainerCommand(
  auth: ResolvedAuth,
  detection: ContainerRuntimeDetection,
  context: McpServerContext,
  options: McpServerOptions = {},
  network: ResolvedNetworkConfig = getNetworkConfig(),
): McpContainerCommand {
  if (!detection.runtime) {
    throw new Error('resolveMcpContainerCommand requires a detected container runtime');
  }
  return detection.viaWsl
    ? getMcpWslContainerCommand(auth, detection.runtime, context, options, network)
    : getMcpContainerCommand(auth, detection.runtime, context, options, network);
}

export function getMcpConfigFilePath(
  agent: string,
  isGlobal: boolean,
  projectRoot: string,
): string {
  if (agent === 'claude') {
    return isGlobal ? join(homedir(), '.claude.json') : join(projectRoot, '.mcp.json');
  } else if (agent === 'copilot') {
    return isGlobal
      ? join(homedir(), '.copilot', 'mcp-config.json')
      : join(projectRoot, '.mcp.json');
  } else if (agent === 'codex') {
    return isGlobal
      ? join(homedir(), '.codex', 'config.toml')
      : join(projectRoot, '.codex', 'config.toml');
  } else if (agent === 'cursor') {
    return isGlobal
      ? join(homedir(), '.cursor', 'mcp.json')
      : join(projectRoot, '.cursor', 'mcp.json');
  } else if (agent === 'antigravity') {
    // Antigravity uses one global MCP file for all workspaces; scope is ignored.
    return ANTIGRAVITY_GLOBAL_MCP_CONFIG_JSON;
  }
  throw new Error(`Unsupported agent: ${agent}`);
}
