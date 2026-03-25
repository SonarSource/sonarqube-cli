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

// MCP Server setup for Claude Code integration

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import { isDockerAvailable } from '../../../../lib/tool-detector';
import { error, info, success, warn } from '../../../../ui';
import { normalizePath } from '../../../../lib/fs-utils';

export async function setupMcpServer(
  agent: string,
  projectRoot: string,
  isGlobal: boolean,
  auth: ResolvedAuth,
  discoveredProjectKey: string | undefined,
): Promise<void> {
  info('Setting up SonarQube MCP Server...');
  const dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    error(
      'Docker is required to configure the SonarQube MCP Server. Please ensure Docker is installed and the daemon is running.',
    );
    warn('Skipping SonarQube MCP Server configuration.');
    return;
  }

  const targetFile = getMcpConfigFilePath(agent);
  const serverConfig = getMcpServerConfig(auth, isGlobal, projectRoot, discoveredProjectKey);

  try {
    await writeMcpServerEntry(targetFile, serverConfig, isGlobal, projectRoot);
  } catch (e: unknown) {
    if (e instanceof Error) {
      error(`Failed to configure SonarQube MCP Server in ${targetFile}: ${e.message}`);
    }
    return;
  }
  success(`SonarQube MCP Server configured in ${targetFile}`);
}

export async function writeMcpServerEntry(
  filePath: string,
  serverConfig: object,
  isGlobal: boolean,
  projectRoot: string,
): Promise<void> {
  let existing: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      existing = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      throw new Error(`${filePath} contains invalid JSON. Please fix or delete it and re-run.`);
    }
  }

  if (isGlobal) {
    const mcpServers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
    existing.mcpServers = { ...mcpServers, sonarqube: serverConfig };
  } else {
    const projectKey = normalizePath(projectRoot);
    const projects = (existing.projects as Record<string, unknown> | undefined) ?? {};
    const projectEntry = (projects[projectKey] as Record<string, unknown> | undefined) ?? {};
    const mcpServers = (projectEntry.mcpServers as Record<string, unknown> | undefined) ?? {};
    projectEntry.mcpServers = { ...mcpServers, sonarqube: serverConfig };
    projects[projectKey] = projectEntry;
    existing.projects = projects;
  }

  mkdirSync(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(existing, null, 2), 'utf-8');
}

export function getMcpConfigFilePath(agent: string): string {
  if (agent === 'claude') {
    return join(homedir(), '.claude.json');
  }
  throw new Error(`Unsupported agent: ${agent}`);
}

export function getMcpServerConfig(
  auth: ResolvedAuth,
  isGlobal: boolean,
  projectRoot: string,
  discoveredProjectKey: string | undefined,
): object {
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

  if (!isGlobal) {
    const hostPath = normalizePath(projectRoot);
    if (discoveredProjectKey) {
      args.push('-e', 'SONARQUBE_PROJECT_KEY');
      env.SONARQUBE_PROJECT_KEY = discoveredProjectKey;
    }
    args.push('-v', `${hostPath}:/app/mcp-workspace:ro`);
  }

  args.push('mcp/sonarqube');

  return { command: 'docker', args, env };
}
