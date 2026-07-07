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

// Run the SonarQube MCP server, proxying stdio for MCP transport

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

import type { ResolvedAuth } from '../../../lib/auth-resolver.js';
import { getNetworkConfig } from '../../../lib/connectivity/network-config.js';
import type { ResolvedNetworkConfig } from '../../../lib/connectivity/types.js';
import { canonicalizePath } from '../../../lib/fs-utils.js';
import logger from '../../../lib/logger';
import { type McpServerContext, resolveMcpContainerCommand } from '../../../lib/mcp/mcp-helper.js';
import { discoverProject } from '../../../lib/project-workspace';
import { detectContainerRuntime } from '../../../lib/tool-detector.js';
import { warn } from '../../../ui';
import { CommandFailedError } from '../_common/error.js';

export interface McpRunOptions {
  debug?: boolean;
  readOnly?: boolean;
  toolsets?: string;
  project?: string;
}

function debugLog(message: string): void {
  logger.debug(message);
  process.stderr.write(`[sonarqube-cli] DEBUG ${message}\n`);
}

export async function runMcp(
  auth: ResolvedAuth,
  options: McpRunOptions = {},
  network: ResolvedNetworkConfig = getNetworkConfig(),
): Promise<void> {
  const detection = await detectContainerRuntime();
  if (!detection.runtime) {
    throw new CommandFailedError('A container runtime (Docker/Podman/Nerdctl) is required.', {
      remediationHint: 'Install and start Docker, Podman, or Nerdctl, then rerun this command.',
    });
  }

  const cwd = process.cwd();
  const cwdIsHomeDir = canonicalizePath(cwd) === canonicalizePath(homedir());
  const discovered = cwdIsHomeDir ? undefined : await discoverProject(cwd, true, { auth });
  const projectKey = options.project || discovered?.projectKey;
  if (!projectKey) {
    warn(
      'No project key found - project-scoped tools will be unavailable. Run sonar run mcp --help for ways to define a project.',
    );
  }
  const discoveredRootIsHomeDir =
    discovered && canonicalizePath(discovered.rootDir) === canonicalizePath(homedir());
  const projectRoot = discoveredRootIsHomeDir ? undefined : discovered?.rootDir;

  const context: McpServerContext = projectRoot
    ? { withFsMount: true, projectRoot, projectKey }
    : { withFsMount: false, projectKey };

  const config = resolveMcpContainerCommand(auth, detection, context, options, network);

  if (options.debug) {
    debugLog(`runtime: ${detection.runtime}${detection.viaWsl ? ' (via WSL)' : ''}`);
    debugLog(`projectRoot: ${projectRoot ?? '(none)'}`);
    debugLog(`projectKey: ${projectKey ?? '(none)'}`);
    debugLog(`launching: ${config.command} ${config.args.join(' ')}`);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(config.command, config.args, {
      stdio: 'inherit',
      env: { ...process.env, ...config.env },
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}
