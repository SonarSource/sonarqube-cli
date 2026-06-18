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

import { version as VERSION } from '../../../../package.json';
import type { ResolvedAuth } from '../../../lib/auth-resolver';
import { resolveAuth } from '../../../lib/auth-resolver';
import { CLI_DIR, GLOBAL_HOOKS_DIR, LOG_DIR } from '../../../lib/config-constants';
import {
  CONTEXT_AUGMENTATION_BINARY_NAME,
  SCA_SCANNER_BINARY_NAME,
} from '../../../lib/install-types';
import { getMcpConfigFilePath } from '../../../lib/mcp/mcp-helper';
import { loadState } from '../../../lib/repository/state-repository';
import {
  SCA_SCANNER_CLI_VERSION,
  SONAR_CONTEXT_AUGMENTATION_VERSION,
} from '../../../lib/signatures';
import type { CliState } from '../../../lib/state';
import { isNewerVersion, stripBuildNumber } from '../../../lib/version';
import { blank, print, success, text, warn } from '../../../ui';
import { getBanner } from '../../root-help';
import { SECRETS_SPEC } from '../_common/install/secrets';
import type { TokenStatus } from '../_common/token';
import { checkTokenStatus } from '../_common/token';
import { supportedIntegrations } from '../integrate';
import { checkAntigravitySecretsHookFile } from '../integrate/antigravity/health';
import { resolveAntigravityHooksJsonPathForScope } from '../integrate/antigravity/hooks';
import { checkForUpdate } from '../self-update/self-update';

const SCA_SCANNER_CACHE_DIR = join(CLI_DIR, 'sca-scanner-cache');

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
      const parsed = parseToml(raw) as Record<string, unknown>;
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

export async function systemStatus(options: SystemStatusOptions): Promise<void> {
  const state = loadState();
  const integrations = getInstalledIntegrations(state);

  const [auth, updateResult] = await Promise.all([
    resolveAuth().catch(() => null),
    checkForUpdate(process.env.SONARQUBE_CLI_UPDATE_SCRIPT_BASE_URL).catch(() => null),
  ]);

  const tokenStatus: TokenStatus | null = auth
    ? await checkTokenStatus(auth.serverUrl, auth.token).catch(() => 'unreachable' as const)
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
  const hasIssues =
    tokenStatus === null || tokenStatus === 'invalid' || hasMcpIssues || hasHooksIssues;
  const recommendations = buildRecommendations(tokenStatus, updateResult, integrations);

  const data: StatusData = {
    auth,
    tokenStatus,
    binaries,
    cache,
    integrations,
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
  tokenStatus: TokenStatus | null;
  binaries: BinaryInfo[];
  cache: CacheInfo[];
  integrations: IntegrationInfo[];
  hasIssues: boolean;
  recommendations: string[];
}

function buildRecommendations(
  tokenStatus: TokenStatus | null,
  updateResult: { latestVersion: string; updateAvailable: boolean } | null,
  integrations: IntegrationInfo[],
): string[] {
  const recommendations: string[] = [];
  if (tokenStatus === null) recommendations.push("Run 'sonar auth login' to authenticate");
  if (tokenStatus === 'invalid') recommendations.push("Run 'sonar auth login' to reauthenticate");
  if (updateResult?.updateAvailable) {
    recommendations.push(
      `Run 'sonar self-update' to update to v${stripBuildNumber(updateResult.latestVersion)}`,
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

function tokenStatusLabel(tokenStatus: TokenStatus | null): string {
  if (tokenStatus === null) return 'not_set';
  if (tokenStatus === 'valid') return 'active';
  if (tokenStatus === 'invalid') return 'invalid';
  return 'set_unverified';
}

function printJsonStatus(version: string, data: StatusData): void {
  const { auth, tokenStatus, binaries, cache, integrations, hasIssues, recommendations } = data;
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
        healthy: !hasIssues,
        recommendations,
      },
      null,
      2,
    ),
  );
}

function renderTokenLine(tokenStatus: TokenStatus | null, serverUrl?: string): void {
  if (tokenStatus === null) text('  • Token:   Not Set');
  else if (tokenStatus === 'valid') text('  • Token:   Active');
  else if (tokenStatus === 'invalid') text('  • Token:   Invalid');
  else text(`  • Token:   Set, Unverified (${serverUrl} is unreachable)`);
}

function renderAuthSection(auth: ResolvedAuth | null, tokenStatus: TokenStatus | null): void {
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

function renderTextStatus(version: string, data: StatusData): void {
  const { auth, tokenStatus, binaries, cache, integrations, hasIssues, recommendations } = data;
  print(getBanner(version));
  blank();

  if (hasIssues) {
    warn('SYSTEM CHECK: Issues found');
  } else {
    success('SYSTEM CHECK: Healthy');
  }
  blank();

  renderAuthSection(auth, tokenStatus);
  renderBinariesSection(binaries);
  renderCacheSection(cache);
  renderIntegrationsSection(integrations);
  renderRecommendationsSection(recommendations);
}
