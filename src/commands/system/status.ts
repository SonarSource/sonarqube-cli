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

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { CLI_DIR, GLOBAL_HOOKS_DIR, LOG_DIR } from '@/core/config-constants.ts';
import type { ResolvedAuth } from '@/core/host/auth-resolver.ts';
import { resolveAuth } from '@/core/host/auth-resolver.ts';
import { getNetworkConfig } from '@/core/host/connectivity/network-config.ts';
import type {
  CaCertConfig,
  ClientCertConfig,
  ConfigSource,
  ProxyGroup,
  ResolvedNetworkConfig,
} from '@/core/host/connectivity/types.ts';
import { CURRENT_DISTRIBUTION } from '@/core/host/distribution.ts';
import {
  CONTEXT_AUGMENTATION_BINARY_NAME,
  SCA_SCANNER_BINARY_NAME,
} from '@/core/host/install-types.ts';
import { getMcpConfigFilePath } from '@/core/host/mcp/mcp-helper.ts';
import {
  SCA_SCANNER_CLI_VERSION,
  SONAR_CONTEXT_AUGMENTATION_VERSION,
} from '@/core/host/signatures.ts';
import type { CliState } from '@/core/state/state.ts';
import { loadState } from '@/core/state/state-repository.ts';
import { blank, print, success, text, warn } from '@/core/ui';
import { isNewerVersion, stripBuildNumber } from '@/core/version.ts';

import { version as VERSION } from '../../../package.json';
import { SECRETS_SPEC } from '../_common/install/secrets.ts';
import type { TokenCheckResult } from '../_common/token.ts';
import { checkTokenStatus } from '../_common/token.ts';
import { supportedIntegrations } from '../integrate';
import { checkAntigravitySecretsHookFile } from '../integrate/antigravity/health.ts';
import { resolveAntigravityHooksJsonPathForScope } from '../integrate/antigravity/hooks.ts';
import { getBanner } from '../root-help.ts';
import { checkForUpdate, type UpdateCheckResult } from '../update/update-check.ts';

const SCA_SCANNER_CACHE_DIR = join(CLI_DIR, 'sca-scanner-cache');

const PROXY_SOURCE_LABELS: Record<ConfigSource, string> = {
  'sonar-env': 'SONAR_HTTPS_PROXY_URL, SONAR_HTTP_PROXY_URL, SONAR_NO_PROXY environment variables',
  'stored-config': 'sonar config',
  'generic-env': 'HTTPS_PROXY, HTTP_PROXY, NO_PROXY environment variables',
};

const CA_CERT_SOURCE_LABELS: Record<ConfigSource, string> = {
  'sonar-env': 'SONAR_CA_CERT environment variable',
  'stored-config': 'sonar config',
  'generic-env': 'NODE_EXTRA_CA_CERTS environment variable',
};

const CLIENT_CERT_SOURCE_LABEL =
  'SONAR_TLS_CLIENT_CERT, SONAR_TLS_CLIENT_KEY_FILE, SONAR_TLS_CLIENT_PASSPHRASE environment variables';

const PINNED_VERSIONS: Partial<Record<string, string>> = {
  [SECRETS_SPEC.name]: SECRETS_SPEC.version,
  [CONTEXT_AUGMENTATION_BINARY_NAME]: SONAR_CONTEXT_AUGMENTATION_VERSION,
  [SCA_SCANNER_BINARY_NAME]: SCA_SCANNER_CLI_VERSION,
};

const BINARY_DISPLAY_NAMES: Record<string, string> = {
  'sonar-secrets': 'Secrets Detection',
  'sonar-context-augmentation': 'Sonar Context Augmentation',
  'sca-scanner-cli': 'Dependency Risks Scanner',
};

export interface SystemStatusOptions {
  json?: boolean;
}

type IntegrationConfigStatus = 'configured' | 'invalid' | 'not_configured';

interface McpStatus {
  config: IntegrationConfigStatus;
}

interface HooksStatus {
  config: IntegrationConfigStatus;
}

interface IntegrationInfo {
  id: string;
  name: string;
  path?: string;
  mcp?: McpStatus;
  hooks?: HooksStatus;
}

type CliUpdateInfo = UpdateCheckResult;

function abbreviatePath(p: string): string {
  return p.replace(homedir(), '~');
}

function getBinaryDisplayName(binaryId: string): string {
  return BINARY_DISPLAY_NAMES[binaryId] ?? binaryId;
}

// integrationId → agent string for getMcpConfigFilePath
const INTEGRATION_TO_MCP_AGENT: Record<string, string> = {
  'claude-code': 'claude',
  'copilot-cli': 'copilot',
  codex: 'codex',
  antigravity: 'antigravity',
};

// integrationId → sonar integrate subcommand
const INTEGRATION_TO_COMMAND: Record<string, string> = {
  'claude-code': 'sonar integrate claude',
  'copilot-cli': 'sonar integrate copilot',
  codex: 'sonar integrate codex',
  antigravity: 'sonar integrate antigravity',
};

function findMcpFeatures(
  state: CliState,
): Array<{ integrationId: string; scope: 'project' | 'global'; targetRoot: string }> {
  const features: Array<{
    integrationId: string;
    scope: 'project' | 'global';
    targetRoot: string;
  }> = [];
  for (const integration of state.integrations.installed) {
    for (const feature of integration.features) {
      if (feature.featureId === 'mcp-server') {
        features.push({
          integrationId: integration.integrationId,
          scope: feature.scope,
          targetRoot: feature.targetRoot,
        });
      }
    }
  }
  return features;
}

function checkMcpConfigFile(configPath: string): IntegrationConfigStatus {
  if (!existsSync(configPath)) return 'not_configured';
  try {
    const raw = readFileSync(configPath, 'utf-8');
    if (configPath.endsWith('.toml')) {
      const parsed = parseToml(raw);
      const mcpServers = parsed.mcp_servers as Record<string, unknown> | undefined;
      if (!mcpServers || !('sonarqube' in mcpServers)) return 'not_configured';
      const entry = mcpServers.sonarqube;
      if (!entry || typeof entry !== 'object') return 'invalid';
      const { command, args } = entry as Record<string, unknown>;
      if (typeof command !== 'string' || command.length === 0 || !Array.isArray(args)) {
        return 'invalid';
      }
      return 'configured';
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const mcpServers = parsed.mcpServers as Record<string, unknown> | undefined;
    if (!mcpServers || !('sonarqube' in mcpServers)) return 'not_configured';
    const entry = mcpServers.sonarqube;
    if (!entry || typeof entry !== 'object') return 'invalid';
    const { command, args } = entry as Record<string, unknown>;
    if (typeof command !== 'string' || command.length === 0 || !Array.isArray(args)) {
      return 'invalid';
    }
    return 'configured';
  } catch {
    return 'invalid';
  }
}

function getMcpStatusForIntegration(
  integrationId: string,
  targetRoot: string,
  allMcpFeatures: Array<{ integrationId: string; scope: 'project' | 'global'; targetRoot: string }>,
): McpStatus | null {
  const agentStr = INTEGRATION_TO_MCP_AGENT[integrationId];
  if (!agentStr) return null;

  const mcpFeatures = allMcpFeatures.filter(
    (f) => f.integrationId === integrationId && f.targetRoot === targetRoot,
  );
  if (mcpFeatures.length === 0) return null;

  let hasInvalid = false;
  for (const feature of mcpFeatures) {
    const configPath = getMcpConfigFilePath(
      agentStr,
      feature.scope === 'global',
      feature.targetRoot,
    );
    const configStatus = checkMcpConfigFile(configPath);
    if (configStatus === 'configured') {
      return { config: 'configured' };
    }
    if (configStatus === 'invalid') {
      hasInvalid = true;
    }
  }
  if (hasInvalid) {
    return { config: 'invalid' };
  }
  return { config: 'not_configured' };
}

function getMcpStatusMap(state: CliState): Map<string, McpStatus> {
  const allMcpFeatures = findMcpFeatures(state);

  if (allMcpFeatures.length === 0) return new Map();

  // Build a Map of unique (integrationId, targetRoot) pairs
  const uniquePairs = new Map<string, { integrationId: string; targetRoot: string }>();
  for (const f of allMcpFeatures) {
    const key = `${f.integrationId}:${f.targetRoot}`;
    if (!uniquePairs.has(key)) {
      uniquePairs.set(key, { integrationId: f.integrationId, targetRoot: f.targetRoot });
    }
  }

  const statusMap = new Map<string, McpStatus>();

  for (const [key, { integrationId, targetRoot }] of uniquePairs) {
    const status = getMcpStatusForIntegration(integrationId, targetRoot, allMcpFeatures);
    if (status) {
      statusMap.set(key, status);
    }
  }
  return statusMap;
}

function findAntigravitySecretsHookFeatures(
  state: CliState,
): Array<{ scope: 'project' | 'global'; targetRoot: string }> {
  const features: Array<{ scope: 'project' | 'global'; targetRoot: string }> = [];
  for (const integration of state.integrations.installed) {
    if (integration.integrationId !== 'antigravity') {
      continue;
    }
    for (const feature of integration.features) {
      if (feature.featureId === 'sonar-secrets-hooks') {
        features.push({ scope: feature.scope, targetRoot: feature.targetRoot });
      }
    }
  }
  return features;
}

function getHooksStatusMap(state: CliState): Map<string, HooksStatus> {
  const hookFeatures = findAntigravitySecretsHookFeatures(state);
  if (hookFeatures.length === 0) {
    return new Map();
  }

  const statusMap = new Map<string, HooksStatus>();
  for (const feature of hookFeatures) {
    const key = `antigravity:${feature.targetRoot}`;
    const hooksPath = resolveAntigravityHooksJsonPathForScope(feature.scope, feature.targetRoot);
    statusMap.set(key, { config: checkAntigravitySecretsHookFile(hooksPath) });
  }
  return statusMap;
}

function getInstalledIntegrations(state: CliState): IntegrationInfo[] {
  const result: IntegrationInfo[] = [];
  const mcpStatusMap = getMcpStatusMap(state);
  const hooksStatusMap = getHooksStatusMap(state);

  // The framework stores one InstalledIntegration per integrationId; multiple
  // project installs accumulate as separate features with distinct targetRoots.
  // Emit one IntegrationInfo per unique project so each installation is visible.
  for (const i of state.integrations.installed) {
    const name = supportedIntegrations.get(i.integrationId)?.displayName ?? i.integrationId;

    // Collect all unique targetRoots across all features (project and global)
    const allRoots = [...new Set(i.features.map((f) => f.targetRoot))];

    for (const root of allRoots) {
      const features = i.features.filter((f) => f.targetRoot === root);
      result.push({
        id: i.integrationId,
        name,
        path: pathFromFeatures(features),
        mcp: mcpStatusMap.get(`${i.integrationId}:${root}`),
        hooks:
          i.integrationId === 'antigravity'
            ? hooksStatusMap.get(`${i.integrationId}:${root}`)
            : undefined,
      });
    }
  }

  // Legacy agents not already covered by declarative state.
  const declarativeIds = new Set(state.integrations.installed.map((i) => i.integrationId));
  for (const [agentId, config] of Object.entries(state.agents)) {
    if (config.configured && !declarativeIds.has(agentId)) {
      const name = supportedIntegrations.get(agentId)?.displayName ?? agentId;
      // Legacy agents don't have MCP info, so leave mcp undefined
      result.push({
        id: agentId,
        name,
        path: getLegacyAgentPath(agentId, state),
        mcp: undefined,
      });
    }
  }

  return result;
}

function pathFromFeatures(
  features: CliState['integrations']['installed'][number]['features'],
): string | undefined {
  for (const feature of features) {
    for (const resource of feature.resources) {
      if (resource.path && !resource.path.endsWith('.sh') && !resource.path.endsWith('.ps1')) {
        return abbreviatePath(resource.path);
      }
    }
  }
  return undefined;
}

function getLegacyAgentPath(agentId: string, state: CliState): string | undefined {
  if (agentId === 'claude-code') {
    const ext = state.agentExtensions.find((e) => e.agentId === 'claude-code' && e.kind === 'hook');
    if (ext) {
      const base = ext.global ? homedir() : ext.projectRoot;
      return abbreviatePath(join(base, '.claude', 'settings.json'));
    }
  }
  return undefined;
}

function mcpStatusLine(mcp: McpStatus): string {
  return integrationConfigStatusLine(mcp.config);
}

function integrationConfigStatusLine(status: IntegrationConfigStatus): string {
  if (status === 'not_configured') return 'NOT CONFIGURED';
  if (status === 'invalid') return 'CONFIGURED / INVALID CONFIG';
  return 'CONFIGURED';
}

async function getCliUpdateInfo(): Promise<CliUpdateInfo | null> {
  if (!CURRENT_DISTRIBUTION.enableSelfUpdate) {
    return null;
  }

  try {
    return await checkForUpdate();
  } catch {
    return null;
  }
}

export async function systemStatus(options: SystemStatusOptions): Promise<void> {
  const state = loadState();
  const integrations = getInstalledIntegrations(state);

  const [auth, updateResult] = await Promise.all([
    resolveAuth().catch(() => null),
    getCliUpdateInfo(),
  ]);

  const tokenStatus: TokenCheckResult | null = auth
    ? await checkTokenStatus(auth.serverUrl, auth.token)
    : null;

  const legacyBinaries = (state.tools?.installed ?? []).map((t) => {
    const pinned = PINNED_VERSIONS[t.name];
    return {
      name: t.name,
      version: t.version,
      path: abbreviatePath(t.path),
      updateAvailable: pinned !== undefined && isNewerVersion(t.version, pinned),
      latestVersion: pinned ?? t.version,
    };
  });

  const depBinaries = state.dependencies.installed
    .filter((d): d is typeof d & { path: string; version: string } => !!(d.path && d.version))
    .map((d) => {
      const pinned = PINNED_VERSIONS[d.id];
      return {
        name: d.id,
        version: d.version,
        path: abbreviatePath(d.path),
        updateAvailable: pinned !== undefined && isNewerVersion(d.version, pinned),
        latestVersion: pinned ?? d.version,
      };
    });

  const seen = new Set(legacyBinaries.map((b) => b.name));
  const binaries = [...legacyBinaries, ...depBinaries.filter((b) => !seen.has(b.name))];

  const cacheDirs = [
    { id: 'logs', name: 'Logs', path: LOG_DIR },
    {
      id: 'sca-scanner-cache',
      name: 'Dependency Risks Scanner Cache',
      path: SCA_SCANNER_CACHE_DIR,
    },
    { id: 'global-git-hooks', name: 'Global Git Hooks', path: GLOBAL_HOOKS_DIR },
  ];
  const cache: CacheInfo[] = cacheDirs.map(({ id, name, path }) => ({
    id,
    name,
    path: abbreviatePath(path),
    present: existsSync(path) && statSync(path).isDirectory(),
  }));

  const hasMcpIssues = integrations.some((i) => i.mcp?.config === 'invalid');
  const hasHooksIssues = integrations.some((i) => i.hooks?.config === 'invalid');

  const network = getNetworkConfig();

  const hasIssues =
    tokenStatus === null ||
    tokenStatus.status === 'invalid' ||
    hasMcpIssues ||
    hasHooksIssues ||
    network.error !== undefined;
  const recommendations = buildRecommendations(tokenStatus, updateResult, integrations, network);

  const data: StatusData = {
    auth,
    tokenStatus,
    binaries,
    cache,
    integrations,
    network,
    hasIssues,
    recommendations,
  };

  if (options.json) {
    printJsonStatus(VERSION, data);
    return;
  }

  renderTextStatus(VERSION, data);
}

type BinaryInfo = {
  name: string;
  version: string;
  path: string;
  updateAvailable: boolean;
  latestVersion: string;
};
type CacheInfo = { id: string; name: string; path: string; present: boolean };

interface StatusData {
  auth: ResolvedAuth | null;
  tokenStatus: TokenCheckResult | null;
  binaries: BinaryInfo[];
  cache: CacheInfo[];
  integrations: IntegrationInfo[];
  network: ResolvedNetworkConfig;
  hasIssues: boolean;
  recommendations: string[];
}

function buildRecommendations(
  tokenStatus: TokenCheckResult | null,
  updateResult: UpdateCheckResult | null,
  integrations: IntegrationInfo[],
  network: ResolvedNetworkConfig,
): string[] {
  const recommendations: string[] = [];
  if (tokenStatus === null) recommendations.push("Run 'sonar auth login' to authenticate");
  if (tokenStatus?.status === 'invalid')
    recommendations.push("Run 'sonar auth login' to reauthenticate");
  if (network.error !== undefined)
    recommendations.push(`Fix client certificate configuration: ${network.error}`);
  if (updateResult && !updateResult.upToDate) {
    recommendations.push(
      `Run 'sonar update' to update to v${updateResult.latest.version.noBuild.text}`,
    );
  }

  const seenMcpIntegrations = new Set<string>();
  for (const integration of integrations) {
    if (seenMcpIntegrations.has(integration.id) || integration.mcp?.config !== 'invalid') {
      continue;
    }
    seenMcpIntegrations.add(integration.id);
    const integrateCmd = INTEGRATION_TO_COMMAND[integration.id] ?? 'sonar integrate claude';
    recommendations.push(`Run '${integrateCmd}' to reinstall MCP configuration`);
  }

  const seenHooksIntegrations = new Set<string>();
  for (const integration of integrations) {
    if (seenHooksIntegrations.has(integration.id) || integration.hooks?.config !== 'invalid') {
      continue;
    }
    seenHooksIntegrations.add(integration.id);
    const integrateCmd = INTEGRATION_TO_COMMAND[integration.id] ?? 'sonar integrate antigravity';
    recommendations.push(`Run '${integrateCmd}' to reinstall secrets hook configuration`);
  }

  return recommendations;
}

function tokenStatusLabel(tokenStatus: TokenCheckResult | null): string {
  if (tokenStatus === null) return 'not_set';
  if (tokenStatus.status === 'valid') return 'active';
  if (tokenStatus.status === 'invalid') return 'invalid';
  return 'set_unverified';
}

function buildClientCertJson(network: ResolvedNetworkConfig) {
  if (network.clientCert) {
    return {
      source: CLIENT_CERT_SOURCE_LABEL,
      certPath: network.clientCert.certPath,
      ...(network.clientCert.keyPath !== null && { keyPath: network.clientCert.keyPath }),
      passphraseSet: Boolean(network.clientCert.passphrase),
    };
  }
  if (network.error !== undefined) {
    return { error: network.error };
  }
  return null;
}

function printJsonStatus(version: string, data: StatusData): void {
  const { auth, tokenStatus, binaries, cache, integrations, network, hasIssues, recommendations } =
    data;
  print(
    JSON.stringify(
      {
        version,
        auth: auth
          ? {
              status: 'authenticated',
              server: auth.serverUrl,
              ...(auth.orgKey ? { org: auth.orgKey } : {}),
              token: tokenStatusLabel(tokenStatus),
              ...(tokenStatus?.errorMessage ? { tokenError: tokenStatus.errorMessage } : {}),
            }
          : { status: 'unauthenticated', token: 'not_set' },
        binaries: binaries.map(({ name, version, path, updateAvailable, latestVersion }) => ({
          id: name,
          name: getBinaryDisplayName(name),
          version,
          path,
          updateAvailable,
          ...(updateAvailable ? { latestVersion: stripBuildNumber(latestVersion) } : {}),
        })),
        cache,
        integrations: integrations.map(({ id, name, path, mcp, hooks }) => ({
          id,
          name,
          ...(path ? { path } : {}),
          ...(mcp
            ? {
                mcp: {
                  configured: mcp.config !== 'not_configured',
                  valid: mcp.config === 'configured',
                },
              }
            : {}),
          ...(hooks
            ? {
                hooks: {
                  configured: hooks.config !== 'not_configured',
                  valid: hooks.config === 'configured',
                },
              }
            : {}),
        })),
        network: {
          proxy: network.proxy
            ? {
                source: PROXY_SOURCE_LABELS[network.proxy.source],
                proxyHttps: network.proxy.proxyHttps?.getUrl() ?? null,
                proxyHttp: network.proxy.proxyHttp?.getUrl() ?? null,
                noProxy: network.proxy.noProxy,
              }
            : null,
          caCert: network.caCert
            ? {
                source: CA_CERT_SOURCE_LABELS[network.caCert.source],
                path: network.caCert.path,
              }
            : null,
          clientCertificate: buildClientCertJson(network),
        },
        healthy: !hasIssues,
        recommendations,
      },
      null,
      2,
    ),
  );
}

function renderTokenLine(tokenStatus: TokenCheckResult | null, serverUrl?: string): void {
  if (tokenStatus === null) {
    text('  • Token:   Not Set');
  } else if (tokenStatus.status === 'valid') {
    text('  • Token:   Active');
  } else if (tokenStatus.status === 'invalid') {
    text('  • Token:   Invalid');
  } else {
    const detail = tokenStatus.errorMessage ? `: ${tokenStatus.errorMessage}` : '';
    text(`  • Token:   Set, Unverified (${serverUrl} is unreachable${detail})`);
  }
}

function renderAuthSection(auth: ResolvedAuth | null, tokenStatus: TokenCheckResult | null): void {
  text('AUTHENTICATION');
  if (auth) {
    text(`  • Server:  ${auth.serverUrl}`);
    if (auth.orgKey) text(`  • Org:     ${auth.orgKey}`);
  }
  renderTokenLine(tokenStatus, auth?.serverUrl);
}

function renderBinariesSection(binaries: BinaryInfo[]): void {
  if (binaries.length === 0) return;
  blank();
  text('BINARIES');
  for (const b of binaries) {
    const displayName = getBinaryDisplayName(b.name);
    text(`  • ${displayName}: Installed (${b.path})`);
    const versionSuffix = b.updateAvailable
      ? ` (Update available: v${stripBuildNumber(b.latestVersion)})`
      : '';
    text(`      Version:  v${b.version}${versionSuffix}`);
  }
}

function renderCacheSection(cache: CacheInfo[]): void {
  blank();
  text('CACHE');
  for (const c of cache) {
    const status = c.present ? c.path : 'empty';
    text(`  • ${c.name}: ${status}`);
  }
}

function renderIntegrationsSection(integrations: IntegrationInfo[]): void {
  if (integrations.length === 0) return;
  blank();
  text('INTEGRATIONS');
  for (const i of integrations) {
    const line = i.path ? `${i.name}: CONFIGURED (${i.path})` : `${i.name}: CONFIGURED`;
    text(`  • ${line}`);
    if (i.mcp) {
      text(`    • MCP Server: ${mcpStatusLine(i.mcp)}`);
    }
    if (i.hooks) {
      text(`    • Secrets Hook: ${integrationConfigStatusLine(i.hooks.config)}`);
    }
  }
}

function renderRecommendationsSection(recommendations: string[]): void {
  if (recommendations.length === 0) return;
  blank();
  text('RECOMMENDATIONS');
  for (const r of recommendations) {
    text(`  • ${r}`);
  }
}

function renderProxySubsection(proxy: ProxyGroup): void {
  blank();
  text(`  Proxy (${PROXY_SOURCE_LABELS[proxy.source]}):`);
  if (proxy.proxyHttps) {
    text(`    • HTTPS:     ${proxy.proxyHttps.getUrl()}`);
  }
  if (proxy.proxyHttp) {
    text(`    • HTTP:      ${proxy.proxyHttp.getUrl()}`);
  }
  if (proxy.noProxy) {
    text(`    • No Proxy:  ${proxy.noProxy}`);
  }
}

function renderCaCertSubsection(caCert: CaCertConfig): void {
  blank();
  text(`  CA Certificate (${CA_CERT_SOURCE_LABELS[caCert.source]}):`);
  text(`    • ${caCert.path}`);
}

function renderClientCertSubsection(
  clientCert: ClientCertConfig | null,
  error: string | undefined,
): void {
  blank();
  text(`  Client Certificate (${CLIENT_CERT_SOURCE_LABEL}):`);
  if (clientCert) {
    text(`    • Certificate: ${clientCert.certPath}`);
    if (clientCert.keyPath !== null) {
      text(`    • Key:         ${clientCert.keyPath}`);
    }
    text(`    • Passphrase:  ${clientCert.passphrase ? 'Set' : 'Not set'}`);
  } else {
    warn(`    ✗ ${error}`);
  }
}

function renderNetworkSection(network: ResolvedNetworkConfig): void {
  blank();
  text('NETWORK');
  if (!network.proxy && !network.caCert && !network.clientCert && !network.error) {
    text('  No advanced network configuration detected.');
    return;
  }
  text(
    '  Note: Not all CLI features currently support proxy and certificate configuration. ' +
      'Secrets hook, Context Augmentation and Software Composition Analysis might currently not pick up the network configuration.',
  );
  if (network.proxy) {
    renderProxySubsection(network.proxy);
  }
  if (network.caCert) {
    renderCaCertSubsection(network.caCert);
  }
  if (network.clientCert ?? network.error) {
    renderClientCertSubsection(network.clientCert, network.error);
  }
}

function renderTextStatus(version: string, data: StatusData): void {
  const { auth, tokenStatus, binaries, cache, integrations, network, hasIssues, recommendations } =
    data;
  print(getBanner(version));
  blank();

  if (hasIssues) {
    warn('SYSTEM CHECK: Issues found');
  } else {
    success('SYSTEM CHECK: Healthy');
  }
  blank();

  renderAuthSection(auth, tokenStatus);
  renderNetworkSection(network);
  renderBinariesSection(binaries);
  renderCacheSection(cache);
  renderIntegrationsSection(integrations);
  renderRecommendationsSection(recommendations);
}
