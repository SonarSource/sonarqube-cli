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

// Every other spec runs the CLI with egress off, so Sentry is never initialized and an SDK
// update that prints at startup ships unnoticed. This spec is the one deliberate exception:
// it runs the compiled binary with production egress and sends all outbound traffic to a
// local proxy that records each request and refuses it, so nothing leaves the machine.

import { mkdirSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ENV_TELEMETRY_EGRESS } from '@/core/telemetry/egress.ts';

import { COVERAGE_RAW_DIR } from '../../../coverage/paths.js';
import { TestHarness } from '../../harness';
import { getCliBinaryPath } from '../../harness/cli-runner.js';

const WORKER_FINISHED_TIMEOUT_MS = 15_000;
// Above the worker wait plus CLI startup, so a slow runner fails on the assertion rather than Bun's 5s default.
const TEST_TIMEOUT_MS = 30_000;

/** Proxy that answers every request, CONNECT tunnels included, with 403 and records its request line. */
async function startBlackholeProxy(): Promise<{ url: string; requests: string[]; server: Server }> {
  const requests: string[] = [];
  const server = createServer((socket) => {
    socket.once('data', (chunk) => {
      requests.push(chunk.toString('latin1').split('\r\n')[0]);
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Blackhole proxy did not bind to a TCP port');
  }
  return { url: `http://127.0.0.1:${address.port}`, requests, server };
}

/** The parent's only request at exit is its Sentry session, so any other host is the telemetry worker. */
function workerRequestRefused(requests: string[]): boolean {
  return requests.some((line) => !line.includes('.sentry.io'));
}

/** The worker renames the queue to a `.sending` file while flushing and deletes it once done. */
function hasInFlightBatch(sonarUserHome: string): boolean {
  try {
    return readdirSync(join(sonarUserHome, 'sonarqube-cli', 'telemetry')).some((entry) =>
      entry.endsWith('.sending'),
    );
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await Bun.sleep(100);
  }
  return condition();
}

describe('Sentry startup output', () => {
  let harness: TestHarness;
  let proxy: Awaited<ReturnType<typeof startBlackholeProxy>>;

  beforeEach(async () => {
    harness = await TestHarness.create();
    proxy = await startBlackholeProxy();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => proxy.server.close(() => resolve()));
    await harness.dispose();
  });

  it(
    'writes nothing to stderr when telemetry is enabled with production egress',
    async () => {
      harness.state().withTelemetryEnabled();
      const env: Record<string, string> = {
        ...harness.env(),
        // The CLI's own proxy variables outrank HTTPS_PROXY/NO_PROXY, so no inherited setting can bypass the blackhole.
        SONAR_HTTPS_PROXY_URL: proxy.url,
        SONAR_HTTP_PROXY_URL: proxy.url,
        SONAR_NO_PROXY: '',
        // Standard variables too, so traffic that bypasses fetch.ts (runtime fetch, child tools) is also refused.
        HTTPS_PROXY: proxy.url,
        HTTP_PROXY: proxy.url,
        https_proxy: proxy.url,
        http_proxy: proxy.url,
        NO_PROXY: '',
        no_proxy: '',
      };
      delete env[ENV_TELEMETRY_EGRESS];
      if (process.env.SONARQUBE_CLI_USE_COVERAGE === '1') {
        mkdirSync(COVERAGE_RAW_DIR, { recursive: true });
        env.COVERAGE_OUTPUT_FILE = join(COVERAGE_RAW_DIR, `coverage-${crypto.randomUUID()}.json`);
      }

      // Spawned directly: the harness runner forces egress off for every invocation.
      mkdirSync(harness.cwd.path, { recursive: true });
      const proc = Bun.spawn([getCliBinaryPath(), 'config', 'list'], {
        env,
        cwd: harness.cwd.path,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      // Waited for before asserting, so the detached worker never outlives the harness, even on failure.
      const workerFinished = await waitFor(
        () => workerRequestRefused(proxy.requests) && !hasInFlightBatch(harness.sonarUserHome.path),
        WORKER_FINISHED_TIMEOUT_MS,
      );

      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      // The worker runs only with production egress, so its refused request proves Sentry was initialized too.
      expect(workerFinished).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
