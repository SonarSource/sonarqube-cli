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

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ResolvedAuth } from '../auth-resolver';
import { CLI_COMMAND } from '../config-constants';
import { normalizePath } from '../fs-utils';
import type { ContainerRuntime } from '../tool-detector';

export interface McpServerConfig {
  command: string;
  args: string[];
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

export function getMcpConfig(
  cliPath: string,
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

  return { command: cliPath, args };
}

// All MCP toolsets supported by the server, excluding 'cag' which is available directly via the CLI.
// Passed explicitly to avoid relying on MCP-side defaults.
export const MCP_DEFAULT_TOOLSETS =
  'analysis,issues,projects,quality-gates,rules,duplications,measures,security-hotspots,dependency-risks,coverage';

export function getMcpContainerCommand(
  auth: ResolvedAuth,
  runtime: ContainerRuntime,
  context: McpServerContext,
  options: McpServerOptions = {},
): McpContainerCommand {
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

  if (context.withFsMount) {
    const hostPath = normalizePath(context.projectRoot);
    args.push('-v', `${hostPath}:/app/mcp-workspace:ro`);
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

  args.push('mcp/sonarqube');

  return { command: runtime, args, env };
}

export async function writeMcpServerEntry(filePath: string, serverConfig: object): Promise<void> {
  let existing: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      existing = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      throw new Error(`${filePath} contains invalid JSON. Please fix or delete it and re-run.`);
    }
  }

  const mcpServers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
  existing.mcpServers = { ...mcpServers, sonarqube: serverConfig };

  mkdirSync(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(existing, null, 2), 'utf-8');
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
  }
  throw new Error(`Unsupported agent: ${agent}`);
}

export async function setupMcpServerForAgent(
  agent: 'claude' | 'copilot',
  projectRoot: string,
  isGlobal: boolean,
  projectKey: string | undefined,
): Promise<void> {
  const targetFile = getMcpConfigFilePath(agent, isGlobal, projectRoot);
  const serverConfig = getMcpConfig(
    CLI_COMMAND,
    isGlobal ? { withFsMount: false } : { withFsMount: true, projectRoot, projectKey },
  );

  await writeMcpServerEntry(targetFile, serverConfig);
}
