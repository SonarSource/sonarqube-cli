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

// Local analysis daemon (sonar-sqaa) integration: identity-hash + socket derivation, daemon
// lifecycle (ensure running), and analysis over a Unix domain socket. Mirrors the
// sonar-context-augmentation daemon-bootstrap pattern. Used only when local analyzer mode is active.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

import type { SqaaAnalysisFile, SqaaAnalysisResponse } from '../sonarqube/client';
import logger from './logger';

/** File extensions handled by the mutualized (context-free) analyzer set, routed to the local daemon. */
const MUTUALIZED_EXTENSIONS = new Set([
  'go',
  'py',
  'ipynb',
  'swift',
  'dart',
  'xml',
  'html',
  'xhtml',
  'yaml',
  'yml',
  'tf',
  'json',
  'sql',
  'pkb',
  'pks',
  'sh',
  'bash',
  'ps1',
  'rb',
]);

/**
 * Context-dependent languages routed to the local daemon to run in no-context (degraded) mode
 * (experimental): reduced accuracy, results will not match SonarQube Cloud. Kept distinct from the
 * context-free MUTUALIZED_EXTENSIONS set so the experimental surface is explicit.
 */
const DEGRADED_LOCAL_EXTENSIONS = new Set([
  'java',
  'kt',
  'kts',
  // C-Family. Plain '.h' is omitted (ambiguous C/C++/Obj-C) and stays on cloud.
  'c',
  'cc',
  'cpp',
  'cxx',
  'c++',
  'hh',
  'hpp',
  'hxx',
  'm',
  'mm',
]);

/** Returns true when local analyzer mode is enabled (via --local flag → env, or directly via env). */
export function isLocalAnalyzerMode(): boolean {
  return process.env.SONAR_SQAA_LOCAL === '1' || process.env.SONAR_SQAA_LOCAL === 'true';
}

/** Marks local analyzer mode active for the rest of the process (set by the --local flag). */
export function enableLocalAnalyzerMode(): void {
  process.env.SONAR_SQAA_LOCAL = '1';
}

/** True when the file belongs to a mutualized language and should be analyzed locally. */
export function isMutualizedFile(filePath: string): boolean {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  if (base.toLowerCase() === 'dockerfile' || base.toLowerCase().endsWith('.dockerfile')) {
    return true;
  }
  const dot = base.lastIndexOf('.');
  if (dot < 0) {
    return false;
  }
  const ext = base.slice(dot + 1).toLowerCase();
  return MUTUALIZED_EXTENSIONS.has(ext) || DEGRADED_LOCAL_EXTENSIONS.has(ext);
}

/** First 16 bytes of SHA-256(serverUrl \0 orgKey) as 32 lowercase hex chars (matches the daemon). */
export function computeIdentityHash(serverUrl: string, orgKey: string): string {
  const hash = createHash('sha256');
  hash.update(serverUrl, 'utf8');
  hash.update(Buffer.from([0]));
  hash.update(orgKey, 'utf8');
  return hash.digest('hex').slice(0, 32);
}

export function socketPathFor(serverUrl: string, orgKey: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return `/tmp/sonar-sqaa-${uid}/${computeIdentityHash(serverUrl, orgKey)}.sock`;
}

interface DaemonAuth {
  serverUrl: string;
  orgKey: string;
  token: string;
}

async function fetchOverSocket(
  socketPath: string,
  path: string,
  init: { method: string; body?: string },
): Promise<{ status: number; text: string }> {
  // Bun extends fetch() with a `unix` option for Unix domain sockets.
  const response = await fetch(`http://localhost${path}`, {
    method: init.method,
    ...(init.body ? { body: init.body, headers: { 'Content-Type': 'application/json' } } : {}),
    unix: socketPath,
  } as RequestInit & { unix: string });
  return { status: response.status, text: await response.text() };
}

async function isDaemonHealthy(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) {
    return false;
  }
  try {
    const { status, text } = await fetchOverSocket(socketPath, '/health', { method: 'GET' });
    return status === 200 && text.includes('ok');
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveDaemonCommand(): { command: string; args: string[] } {
  // For local development the daemon launcher is provided via SONAR_SQAA_BIN
  // (e.g. analysis/sonar-sqaa/bin/sonar-sqaa). Phase 2 will resolve a published binary instead.
  const bin = process.env.SONAR_SQAA_BIN;
  if (!bin) {
    throw new Error(
      'Local analyzer mode requires SONAR_SQAA_BIN to point at the sonar-sqaa launcher (e.g. analysis/sonar-sqaa/bin/sonar-sqaa).',
    );
  }
  return { command: bin, args: ['tool', 'integrate'] };
}

/** Ensures the daemon for (serverUrl, orgKey) is running and healthy, spawning it if needed. */
export async function ensureSonarSqaa(auth: DaemonAuth, timeoutMs = 60_000): Promise<string> {
  const socketPath = socketPathFor(auth.serverUrl, auth.orgKey);
  if (await isDaemonHealthy(socketPath)) {
    logger.debug(`sonar-sqaa daemon already healthy at ${socketPath}`);
    return socketPath;
  }

  const { command, args } = resolveDaemonCommand();
  logger.debug(`Spawning sonar-sqaa daemon: ${command} ${args.join(' ')}`);
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      SONAR_SQAA_URL: auth.serverUrl,
      SONAR_SQAA_ORGANIZATION: auth.orgKey,
      SONAR_SQAA_TOKEN: auth.token,
    },
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDaemonHealthy(socketPath)) {
      logger.debug(`sonar-sqaa daemon healthy at ${socketPath}`);
      return socketPath;
    }
    await sleep(200);
  }
  throw new Error(
    `sonar-sqaa daemon did not become healthy within ${timeoutMs}ms (socket ${socketPath})`,
  );
}

/** Analyze files via the local daemon, returning the same shape as the cloud createAnalysis response. */
export async function analyzeViaDaemon(
  auth: DaemonAuth,
  projectKey: string,
  branch: string | undefined,
  files: SqaaAnalysisFile[],
  options: { analysisDepth?: 'DEEP' } = {},
): Promise<SqaaAnalysisResponse> {
  const socketPath = await ensureSonarSqaa(auth);
  const body = JSON.stringify({
    organizationKey: auth.orgKey,
    projectKey,
    ...(branch ? { branchName: branch } : {}),
    ...(options.analysisDepth ? { analysisDepth: options.analysisDepth } : {}),
    files,
  });
  const { status, text } = await fetchOverSocket(socketPath, '/a3s-analysis/analyses', {
    method: 'POST',
    body,
  });
  if (status !== 200) {
    throw new Error(`Local sonar-sqaa analysis failed: HTTP ${status} ${text}`);
  }
  const response = JSON.parse(text) as SqaaAnalysisResponse;
  warnIfDegraded(response);
  return response;
}

let degradedWarningEmitted = false;

/**
 * Context-dependent languages (Java/Kotlin/C-Family) currently run locally in no-context (degraded)
 * mode: the daemon emits an INVALID_CONTEXT error when an analyzer falls back. Warn the user once that
 * accuracy is reduced and results will not match SonarQube Cloud.
 */
function warnIfDegraded(response: SqaaAnalysisResponse): void {
  if (degradedWarningEmitted || !response.errors?.some((e) => e.code === 'INVALID_CONTEXT')) {
    return;
  }
  degradedWarningEmitted = true;
  logger.warn(
    'Local analysis ran in degraded (no-context) mode for one or more files: reduced accuracy, ' +
      'results will not match SonarQube Cloud.',
  );
}
