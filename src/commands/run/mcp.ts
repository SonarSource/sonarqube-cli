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

import { type ChildProcess, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CliError, CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { getNetworkConfigOrThrow } from '@/core/host/connectivity/network-config.ts';
import type { ResolvedNetworkConfig } from '@/core/host/connectivity/types.ts';
import {
  type ContainerRuntimeDetection,
  detectContainerRuntime,
} from '@/core/host/environment/tool-detector.ts';
import { HostedMcpClient } from '@/core/host/mcp/hosted-mcp-client.ts';
import {
  clientCertCachePath,
  type McpServerContext,
  resolveMcpContainerCommand,
} from '@/core/host/mcp/mcp-helper.ts';
import { removeJvmSecretsFile } from '@/core/host/mcp/mcp-jvm-secrets.ts';
import {
  isLoopbackServerUrl,
  mcpLoopbackAdvice,
  readMcpContainerSettings,
  resolveMcpContainerNetworking,
} from '@/core/host/mcp/mcp-network.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import {
  assertSingleLineProjectKey,
  discoverProject,
} from '@/core/project-discovery/project-info.ts';

import { bridgeHostedMcp } from './hosted-mcp-bridge.ts';

export interface McpRunOptions {
  transport?: 'stdio' | 'http' | 'auto';
  debug?: boolean;
  readOnly?: boolean;
  toolsets?: string;
  project?: string;
}

const AUTHENTICATION_ERROR_MESSAGE = "Not authenticated. Run 'sonar auth login' to authenticate.";
const INTERNAL_ERROR_CODE = -32000;
const HANGUP_EXIT_CODE = 129;
const INTERRUPTED_EXIT_CODE = 130;
const TERMINATED_EXIT_CODE = 143;
const CONTAINER_SHUTDOWN_EXIT_CODES = new Set([INTERRUPTED_EXIT_CODE, TERMINATED_EXIT_CODE]);

function debugLog(message: string): void {
  logger.debug(message);
  process.stderr.write(`[sonarqube-cli] DEBUG ${message}\n`);
}

export async function runMcp(
  ctx: CommandInvocationContext,
  options: McpRunOptions = {},
  network?: ResolvedNetworkConfig,
): Promise<void> {
  let resolvedNetwork: ResolvedNetworkConfig | undefined;
  try {
    resolvedNetwork = network ?? (await getNetworkConfigOrThrow());
    const auth = await resolveMcpAuth(ctx);
    if (options.transport !== 'stdio' && (await tryRunHostedMcp(ctx, auth, options))) return;
    await runMcpContainer(ctx, auth, options, resolvedNetwork);
  } catch (error) {
    const startupError = asStartupError(error);
    if (process.stdin.isTTY) throw startupError;
    const message = startupError.remediationHint
      ? `${startupError.message} ${startupError.remediationHint}`
      : startupError.message;
    process.stderr.write(`[sonarqube-cli] MCP startup failed: ${message}\n`);
    await respondToInitializeWithError(message, startupError.exitCode);
  } finally {
    if (resolvedNetwork?.clientCert?.format === 'pem') {
      removeCachedCertificate(clientCertCachePath(resolvedNetwork.clientCert), 'client');
    }
  }
}

async function resolveMcpAuth(ctx: CommandInvocationContext): Promise<ResolvedAuth> {
  const result = await ctx.resolveAuth();
  if (result.isErr()) throw result.error;
  if (!result.value) throw new CommandFailedError(AUTHENTICATION_ERROR_MESSAGE);
  return result.value;
}

async function tryRunHostedMcp(
  ctx: CommandInvocationContext,
  auth: ResolvedAuth,
  options: McpRunOptions,
): Promise<boolean> {
  const hosted = new HostedMcpClient(ctx.withAuth(auth).connection);
  const availability = await hosted.checkHealth();
  if (availability.available) {
    process.stderr.write(`[sonarqube-cli] MCP: hosted endpoint ${hosted.url}\n`);
    await bridgeHostedMcp(hosted, options);
    return true;
  }
  const hint =
    auth.connectionType === 'on-premise'
      ? ' For SonarQube Server 2026.3+, ask an administrator to configure and enable hosted MCP.'
      : '';
  if (options.transport === 'http') {
    throw new CommandFailedError(
      `Hosted MCP unavailable — ${hosted.url}/health ${availability.reason}.${hint}`,
    );
  }
  process.stderr.write(
    `[sonarqube-cli] MCP: local container fallback — ${hosted.url}/health ${availability.reason}.${hint}\n`,
  );
  return false;
}

async function resolveContainerContext(
  ctx: CommandInvocationContext,
  auth: ResolvedAuth,
  options: McpRunOptions,
): Promise<McpServerContext> {
  const cwd = process.cwd();
  const cwdIsHomeDir = canonicalizePath(cwd) === canonicalizePath(homedir());
  const discovered = cwdIsHomeDir
    ? undefined
    : await discoverProject(cwd, { auth, silent: true, console: ctx.console });
  // Do not noteProject: a long-running MCP process may never emit its command-executed event.
  const projectKey = options.project || discovered?.projectKey;
  if (projectKey) assertSingleLineProjectKey(projectKey);
  if (!projectKey) {
    ctx.console.warn(
      'No project key found - project-scoped tools will be unavailable. Run sonar run mcp --help for ways to define a project.',
    );
  }
  const discoveredRootIsHomeDir =
    discovered && canonicalizePath(discovered.projectRoot) === canonicalizePath(homedir());
  const projectRoot = discoveredRootIsHomeDir ? undefined : discovered?.projectRoot;
  return projectRoot
    ? { withFsMount: true, projectRoot, projectKey }
    : { withFsMount: false, projectKey };
}

async function runMcpContainer(
  ctx: CommandInvocationContext,
  auth: ResolvedAuth,
  options: McpRunOptions,
  network: ResolvedNetworkConfig,
): Promise<void> {
  const context = await resolveContainerContext(ctx, auth, options);
  const detection = await detectContainerRuntime();
  if (!detection.runtime) throw runtimeDetectionError(detection);
  const settings = await readMcpContainerSettings();
  const container = resolveMcpContainerNetworking(auth, detection, settings);
  if (options.transport === 'stdio') {
    process.stderr.write(
      `[sonarqube-cli] MCP: local container via ${detection.runtime} — ${container.serverUrl} (forced by --transport stdio)\n`,
    );
  }
  const config = resolveMcpContainerCommand(
    auth,
    detection,
    context,
    {
      ...options,
      containerNetwork: container.network,
      containerAddHost: container.addHost,
      containerServerUrl: container.serverUrl,
    },
    network,
  );
  let child: ChildProcess | undefined;
  const disposeJvmSecrets = config.jvmSecretsPath
    ? ownJvmSecrets(config.jvmSecretsPath, () => child)
    : undefined;
  try {
    if (options.debug) {
      debugLog(`runtime: ${detection.runtime}${detection.viaWsl ? ' (via WSL)' : ''}`);
      debugLog(`projectRoot: ${context.withFsMount ? context.projectRoot : '(none)'}`);
      debugLog(`projectKey: ${context.projectKey ?? '(none)'}`);
      debugLog(`launching: ${config.command} ${config.args.join(' ')}`);
    }
    child = spawn(config.command, config.args, {
      stdio: 'inherit',
      env: { ...process.env, ...config.env },
    });
    await waitForContainerExit(child, container.serverUrl, mcpLoopbackAdvice(auth, settings));
  } finally {
    disposeJvmSecrets?.();
    if (config.cachedCaCertPath) removeCachedCertificate(config.cachedCaCertPath, 'CA');
  }
}

function waitForContainerExit(
  child: ChildProcess,
  serverUrl: string,
  networkHint: string | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
      if (
        code !== null &&
        code !== 0 &&
        !CONTAINER_SHUTDOWN_EXIT_CODES.has(code) &&
        isLoopbackServerUrl(serverUrl) &&
        networkHint
      ) {
        process.stderr.write(
          `[sonarqube-cli] The MCP container exited with an error. Check that its SonarQube URL is reachable from the container. ${networkHint}\n`,
        );
      }
      resolve();
    });
  });
}

function removeCachedCertificate(path: string, kind: string): void {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    // Windows: Docker Desktop may still hold the file; content-addressed so safe to leave behind.
    logger.warn(`Could not remove cached ${kind} certificate: ${String(error)}`);
  }
}

function ownJvmSecrets(path: string, getChild: () => ChildProcess | undefined): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const [signal, handler] of handlers) process.off(signal, handler);
    removeJvmSecretsFile(path);
  };
  for (const [signal, code] of [
    ['SIGHUP', HANGUP_EXIT_CODE],
    ['SIGINT', INTERRUPTED_EXIT_CODE],
    ['SIGTERM', TERMINATED_EXIT_CODE],
  ] as const) {
    const handler = () => {
      dispose();
      try {
        getChild()?.kill(signal);
      } catch {
        // Cleanup and exit must finish even if the runtime cannot receive the signal.
      }
      process.exit(code);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return dispose;
}

function runtimeDetectionError(detection: ContainerRuntimeDetection): CommandFailedError {
  const failure = detection.nativeFailure;
  if (failure) {
    const exit = failure.exitCode === null ? '' : ` (exit ${failure.exitCode})`;
    return new CommandFailedError(
      `${failure.runtime[0].toUpperCase()}${failure.runtime.slice(1)} is installed but not reachable${exit}: ${failure.stderr || 'No error output.'}`,
      {
        remediationHint: `Start ${failure.runtime} and rerun this command, or set SONARQUBE_CLI_MCP_WSL=always if your container runtime runs in WSL.`,
      },
    );
  }
  if (detection.wslOnly) {
    return new CommandFailedError(
      'No container runtime (Docker/Podman/Nerdctl) is available in WSL.',
      {
        remediationHint:
          'SONARQUBE_CLI_MCP_WSL=always checks WSL only. Start your runtime in WSL, or set SONARQUBE_CLI_MCP_WSL=auto to check native runtimes.',
      },
    );
  }
  return new CommandFailedError('A container runtime (Docker/Podman/Nerdctl) is required.', {
    remediationHint: 'Install and start Docker, Podman, or Nerdctl, then rerun this command.',
  });
}

function asStartupError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  return new CommandFailedError(
    error instanceof Error ? error.message : 'An unexpected error occurred.',
    { cause: error },
  );
}

async function respondToInitializeWithError(message: string, exitCode: number): Promise<void> {
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
    process.exitCode = exitCode;
    return;
  }
  process.exitCode = exitCode;
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
