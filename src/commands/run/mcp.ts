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
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { getNetworkConfigOrThrow } from '@/core/host/connectivity/network-config.ts';
import type { ResolvedNetworkConfig } from '@/core/host/connectivity/types.ts';
import { detectContainerRuntime } from '@/core/host/environment/tool-detector.ts';
import {
  clientCertCachePath,
  type McpServerContext,
  resolveMcpContainerCommand,
} from '@/core/host/mcp/mcp-helper.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import { assertSingleLineProjectKey, discoverProject } from '@/core/project-info.ts';

export interface McpRunOptions {
  debug?: boolean;
  readOnly?: boolean;
  toolsets?: string;
  project?: string;
}

const AUTHENTICATION_ERROR_MESSAGE = "Not authenticated. Run 'sonar auth login' to authenticate.";
const INTERNAL_ERROR_CODE = -32000;

function debugLog(message: string): void {
  logger.debug(message);
  process.stderr.write(`[sonarqube-cli] DEBUG ${message}\n`);
}

export async function runMcp(
  ctx: CommandInvocationContext,
  options: McpRunOptions = {},
  network: ResolvedNetworkConfig = getNetworkConfigOrThrow(),
): Promise<void> {
  try {
    const authResult = await ctx.resolveAuth();
    if (authResult.isErr()) {
      await respondToInitializeWithError(authResult.error.message);
      return;
    }
    if (!authResult.value) {
      await respondToInitializeWithError(AUTHENTICATION_ERROR_MESSAGE);
      return;
    }

    const auth = authResult.value;
    const { console } = ctx;
    const detection = await detectContainerRuntime();
    if (!detection.runtime) {
      await respondToInitializeWithError(
        'A container runtime (Docker/Podman/Nerdctl) is required. Install and start Docker, Podman, or Nerdctl, then rerun this command.',
      );
      return;
    }

    const cwd = process.cwd();
    const cwdIsHomeDir = canonicalizePath(cwd) === canonicalizePath(homedir());
    const discovered = cwdIsHomeDir
      ? undefined
      : await discoverProject(cwd, { auth, silent: true, console });
    // Deliberately does NOT call `noteProject` (telemetry/project-uuid.ts), unlike the other
    // commands that resolve a project key: this starts a long-running server, and
    // CliCommandExecuted is only emitted from the postAction hook once it exits — or never, if
    // the process is killed. Attaching project_uuid to an event that unreliable buys nothing.
    const projectKey = options.project || discovered?.projectKey;
    if (projectKey) {
      assertSingleLineProjectKey(projectKey);
    }
    if (!projectKey) {
      console.warn(
        'No project key found - project-scoped tools will be unavailable. Run sonar run mcp --help for ways to define a project.',
      );
    }
    const discoveredRootIsHomeDir =
      discovered && canonicalizePath(discovered.projectRoot) === canonicalizePath(homedir());
    const projectRoot = discoveredRootIsHomeDir ? undefined : discovered?.projectRoot;

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
  } catch (error) {
    await respondToInitializeWithError(
      error instanceof Error ? error.message : 'An unexpected error occurred.',
    );
  } finally {
    cleanup(network);
  }

  function cleanup(network: ResolvedNetworkConfig) {
    if (network.clientCert?.format === 'pem') {
      try {
        rmSync(clientCertCachePath(network.clientCert), { force: true });
      } catch (err) {
        // Windows: Docker Desktop may still hold the file; content-addressed so safe to leave behind
        logger.warn(`Could not remove cached client certificate: ${String(err)}`);
      }
    }
  }
}

async function respondToInitializeWithError(message: string): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    const request = parseInitializeRequest(line);
    if (request === undefined) {
      continue;
    }

    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: INTERNAL_ERROR_CODE, message },
      })}\n`,
    );
    input.close();
    process.exitCode = 1;
    return;
  }
  process.exitCode = 1;
}

function parseInitializeRequest(line: string): { id: unknown } | undefined {
  try {
    const request: unknown = JSON.parse(line);
    if (typeof request === 'object' && request !== null) {
      const requestRecord = request as Record<string, unknown>;
      if ('id' in requestRecord && requestRecord.method === 'initialize') {
        return { id: requestRecord.id };
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
