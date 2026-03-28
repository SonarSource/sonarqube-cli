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

// Health check orchestrator for OpenAI Codex integration

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { hasSonarqubeMcpBlockInToml } from './codex-config';
import { areCodexSecretsHooksInstalled } from './hooks';
import { logAndValidate, runSonarQubeConnectivityChecks } from '../_common/integrate-health-core';

export interface CodexHealthCheckResult {
  tokenValid: boolean;
  serverAvailable: boolean;
  projectAccessible: boolean;
  organizationAccessible: boolean;
  qualityProfilesAccessible: boolean;
  mcpConfigured: boolean;
  hooksInstalled: boolean;
  errors: string[];
}

export interface CodexHealthCheckOptions {
  serverURL: string;
  token: string;
  projectKey: string | undefined;
  organization: string | undefined;
  verbose: boolean;
  /** When true, require `[mcp_servers.sonarqube]` in `codexConfigTomlPath`. */
  verifyMcp: boolean;
  /** When true, require sonar-secrets entries under `hooksRoot/.codex/hooks.json`. */
  verifyHooks: boolean;
  codexConfigTomlPath?: string;
  hooksRoot?: string;
}

/**
 * Run health checks for Codex: SonarQube API plus optional MCP and secrets-hooks verification.
 */
export async function runCodexHealthChecks(
  options: CodexHealthCheckOptions,
): Promise<CodexHealthCheckResult> {
  const {
    serverURL,
    token,
    projectKey,
    organization,
    verbose,
    verifyMcp,
    verifyHooks,
    codexConfigTomlPath,
    hooksRoot,
  } = options;

  const errors: string[] = [];

  const connectivity = await runSonarQubeConnectivityChecks(
    serverURL,
    token,
    projectKey,
    organization,
    verbose,
    errors,
  );

  let mcpConfigured = true;
  if (verifyMcp) {
    mcpConfigured = await logAndValidate(
      'Checking Codex MCP in config.toml...',
      async () => {
        if (!codexConfigTomlPath || !existsSync(codexConfigTomlPath)) {
          return false;
        }
        const content = await readFile(codexConfigTomlPath, 'utf-8');
        return hasSonarqubeMcpBlockInToml(content);
      },
      'SonarQube MCP not configured in Codex config.toml',
      errors,
      verbose,
    );
  }

  let hooksInstalled = true;
  if (verifyHooks) {
    hooksInstalled = await logAndValidate(
      'Checking Codex secrets hooks...',
      async () => {
        if (!hooksRoot) {
          return false;
        }
        return areCodexSecretsHooksInstalled(hooksRoot);
      },
      'Codex secrets hooks not installed',
      errors,
      verbose,
    );
  }

  return {
    ...connectivity,
    mcpConfigured,
    hooksInstalled,
    errors,
  };
}
