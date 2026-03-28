/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

/**
 * Merge SonarQube MCP server into ~/.codex/config.toml (or project .codex/config.toml)
 * without a TOML parser dependency. Format follows https://developers.openai.com/codex/mcp
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import { CODEX_AGENT_DIR_NAME, CODEX_USER_CONFIG_FILE } from '../../../../lib/config-constants';
import { buildSonarMcpDockerSpec } from '../_common/sonar-mcp-docker-spec';
import type { SonarMcpDockerServerSpec } from '../_common/sonar-mcp-docker-spec';

function tomlDoubleQuotedString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlStringArray(arr: string[]): string {
  return `[${arr.map((x) => tomlDoubleQuotedString(x)).join(', ')}]`;
}

function mcpSonarqubeTomlFromSpec(spec: SonarMcpDockerServerSpec): string {
  const lines: string[] = [
    '[mcp_servers.sonarqube]',
    `command = ${tomlDoubleQuotedString(spec.command)}`,
    `args = ${tomlStringArray(spec.args)}`,
    '',
    '[mcp_servers.sonarqube.env]',
  ];
  for (const [k, v] of Object.entries(spec.env)) {
    lines.push(`${k} = ${tomlDoubleQuotedString(v)}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface WriteCodexTomlIntegrationParams {
  configFilePath: string;
  auth: ResolvedAuth;
  isGlobal: boolean;
  projectRoot: string;
  projectKey: string | undefined;
  /** When true, (re)write `[mcp_servers.sonarqube]` from the shared Docker MCP spec. */
  includeMcp: boolean;
  /** When true, ensure `[features] codex_hooks = true` (required for hooks.json). */
  includeHooksFeature: boolean;
}

/**
 * Single write path for project or user `config.toml`: optional MCP block, optional `codex_hooks`.
 * No-op when both flags are false.
 */
export async function writeCodexTomlIntegration(
  params: WriteCodexTomlIntegrationParams,
): Promise<void> {
  const {
    configFilePath,
    auth,
    isGlobal,
    projectRoot,
    projectKey,
    includeMcp,
    includeHooksFeature,
  } = params;

  if (!includeMcp && !includeHooksFeature) {
    return;
  }

  mkdirSync(dirname(configFilePath), { recursive: true });

  let existing = '';
  if (existsSync(configFilePath)) {
    existing = await readFile(configFilePath, 'utf-8');
  }

  const body = existing.trimEnd();
  let merged: string;

  if (includeMcp) {
    const stripped = body.length > 0 ? stripMcpServersSonarqubeBlock(body) : '';
    const spec = buildSonarMcpDockerSpec(auth, isGlobal, projectRoot, projectKey);
    const mcpBlock = mcpSonarqubeTomlFromSpec(spec);
    merged = stripped.length > 0 ? `${stripped}\n\n${mcpBlock}` : mcpBlock;
  } else {
    merged = body;
  }

  if (includeHooksFeature) {
    merged = mergeFeaturesCodexHooks(merged);
  }

  await writeFile(configFilePath, `${merged.trim()}\n`, 'utf-8');
}

/**
 * Remove existing [mcp_servers.sonarqube] and [mcp_servers.sonarqube.env] sections from TOML text.
 */
export function stripMcpServersSonarqubeBlock(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let skip = false;
  for (const line of lines) {
    const header = /^\[[^\]]+\]\s*$/.test(line.trim());
    if (header) {
      if (
        line.trim() === '[mcp_servers.sonarqube]' ||
        line.trim() === '[mcp_servers.sonarqube.env]'
      ) {
        skip = true;
        continue;
      }
      skip = false;
    }
    if (!skip) {
      out.push(line);
    }
  }
  return out.join('\n');
}

/**
 * Ensure `[features].codex_hooks = true` for Codex command hooks (required by Codex when using hooks.json).
 * Replaces `codex_hooks = false` if present — otherwise hooks.json is ignored at runtime.
 */
export function mergeFeaturesCodexHooks(content: string): string {
  const upgraded = content.replace(/^\s*codex_hooks\s*=\s*false\s*$/m, 'codex_hooks = true');
  if (/codex_hooks\s*=\s*true/m.test(upgraded)) {
    return upgraded;
  }
  const lines = upgraded.split('\n');
  const idx = lines.findIndex((l) => l.trim() === '[features]');
  if (idx >= 0) {
    const after = lines.slice(idx + 1);
    const hasKey = after.some((l) => /^\s*codex_hooks\s*=/.test(l));
    if (hasKey) {
      return upgraded;
    }
    const next = [...lines.slice(0, idx + 1), 'codex_hooks = true', ...lines.slice(idx + 1)];
    return next.join('\n');
  }
  return `${upgraded.trimEnd()}\n\n[features]\ncodex_hooks = true\n`;
}

async function mergeCodexHooksFeatureOnly(configFilePath: string): Promise<void> {
  mkdirSync(dirname(configFilePath), { recursive: true });

  let existing = '';
  if (existsSync(configFilePath)) {
    existing = await readFile(configFilePath, 'utf-8');
  }

  const merged = mergeFeaturesCodexHooks(existing.trimEnd());
  await writeFile(configFilePath, `${merged.trim()}\n`, 'utf-8');
}

/**
 * When hooks live under `<repo>/.codex/`, Codex still merges session `features` from
 * `~/.codex/config.toml`. If that file exists without `codex_hooks = true`, the hook engine
 * may register zero handlers (see https://developers.openai.com/codex/hooks).
 *
 * @returns whether `~/.codex/config.toml` existed and was updated.
 */
export async function mergeCodexHooksFeatureUserLayerIfPresent(): Promise<boolean> {
  if (!existsSync(CODEX_USER_CONFIG_FILE)) {
    return false;
  }
  await mergeCodexHooksFeatureOnly(CODEX_USER_CONFIG_FILE);
  return true;
}

/**
 * Codex merges config layers so a **project** `.codex/config.toml` can override `~/.codex/config.toml`.
 * If the repo has `[features] codex_hooks = false`, hooks never run even after `integrate codex -g`
 * (see https://developers.openai.com/codex/hooks — feature defaults off until enabled in merged config).
 *
 * @returns whether the project file existed and was changed.
 */
export async function mergeCodexHooksFeatureProjectLayerIfPresent(
  projectRoot: string,
): Promise<boolean> {
  const configPath = join(projectRoot, CODEX_AGENT_DIR_NAME, 'config.toml');
  if (!existsSync(configPath)) {
    return false;
  }
  const existing = (await readFile(configPath, 'utf-8')).trimEnd();
  const merged = mergeFeaturesCodexHooks(existing);
  if (merged.trimEnd() === existing) {
    return false;
  }
  await writeFile(configPath, `${merged.trim()}\n`, 'utf-8');
  return true;
}

/** True if config.toml contains the SonarQube MCP server block. */
export function hasSonarqubeMcpBlockInToml(content: string): boolean {
  return /^\[mcp_servers\.sonarqube\]\s*$/m.test(content);
}
