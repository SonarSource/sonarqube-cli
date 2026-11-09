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

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { prepareScannerEngine } from '@/commands/init/scan/prepare-scanner-engine.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

const engine = new Uint8Array([0, 255, 17, 42]);
const sha256 = createHash('sha256').update(engine).digest('hex');
const token = 'dummy-engine-token';

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe('scanner engine provisioning', () => {
  let directory: string;
  let fetchSpy: ReturnType<typeof spyOn>;
  let requests: { url: string; headers: Headers }[];
  let version: unknown;
  let metadata: unknown;
  let downloadStatus: number;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'engine-test-'));
    requests = [];
    version = '10.6.0.1';
    metadata = { sha256, filename: '../../untrusted.jar' };
    downloadStatus = 200;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const headers = new Headers(init?.headers);
      requests.push({ url, headers });
      if (url.endsWith('/api/system/status')) return Promise.resolve(Response.json({ version }));
      if (headers.get('Accept') === 'application/json')
        return Promise.resolve(Response.json(metadata));
      return Promise.resolve(new Response(engine, { status: downloadStatus }));
    }) as typeof fetch);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    ['https://sonarcloud.io', 'https://api.sonarcloud.io/analysis/engine'],
    ['https://sonarqube.us', 'https://api.sonarqube.us/analysis/engine'],
    ['https://sonar.example/context/', 'https://sonar.example/context/api/v2/analysis/engine'],
  ])('provisions the authenticated engine for %s', async (server, endpoint) => {
    const path = await prepareScannerEngine(new SonarHttpClient(server, token), directory);
    expect(isAbsolute(path)).toBe(true);
    expect(path).toBe(join(directory, 'scanner-engine.jar'));
    expect(new Uint8Array(readFileSync(path))).toEqual(engine);
    expect(readdirSync(directory)).toEqual(['scanner-engine.jar']);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    const calls = requests.filter((request) => request.url === endpoint);
    expect(calls.map((call) => call.headers.get('Accept'))).toEqual([
      'application/json',
      'application/octet-stream',
    ]);
    expect(
      requests.every((request) => request.headers.get('Authorization') === `Bearer ${token}`),
    ).toBe(true);
  });

  it('downloads a supplied URL without credentials and accepts uppercase SHA-256', async () => {
    metadata = { sha256: sha256.toUpperCase(), downloadUrl: 'https://cdn.example/engine.jar' };
    await prepareScannerEngine(new SonarHttpClient('https://sonarcloud.io', token), directory);
    expect(requests.map((request) => request.url)).toEqual([
      'https://api.sonarcloud.io/analysis/engine',
      'https://cdn.example/engine.jar',
    ]);
    expect(requests[1].headers.has('Authorization')).toBe(false);
  });

  it.each([undefined, '', '   '])(
    'uses authenticated fallback for downloadUrl %p',
    async (downloadUrl) => {
      metadata = { sha256, downloadUrl };
      await prepareScannerEngine(new SonarHttpClient('https://sonarcloud.io', token), directory);
      expect(requests).toHaveLength(2);
      expect(requests[1].headers.get('Authorization')).toBe(`Bearer ${token}`);
    },
  );

  it.each(['9.9.8', '10.5.9'])(
    'keeps legacy bootstrap for Server %s without the engine endpoint',
    async (serverVersion) => {
      version = serverVersion;
      expect(
        await prepareScannerEngine(new SonarHttpClient('https://sonar.example', token), directory),
      ).toBe('');
      expect(requests.map((request) => request.url)).toEqual([
        'https://sonar.example/api/system/status',
      ]);
      expect(readdirSync(directory)).toEqual([]);
    },
  );

  it.each([undefined, null, 10.6, '', 'unknown', '10', '10.6oops', '10..6'])(
    'fails closed on version %p',
    async (invalid) => {
      version = invalid;
      expect(
        (
          await failureOf(
            prepareScannerEngine(new SonarHttpClient('https://sonar.example', token), directory),
          )
        ).message,
      ).toContain('valid version');
      expect(requests).toHaveLength(1);
      expect(readdirSync(directory)).toEqual([]);
    },
  );

  it.each([null, {}, { sha256: 'bad' }, { sha256: '0'.repeat(63) }, { sha256, downloadUrl: 4 }])(
    'rejects malformed metadata %p before downloading',
    async (invalid) => {
      metadata = invalid;
      expect(
        (
          await failureOf(
            prepareScannerEngine(new SonarHttpClient('https://sonarcloud.io', token), directory),
          )
        ).message,
      ).toContain('invalid scanner engine metadata');
      expect(requests).toHaveLength(1);
      expect(readdirSync(directory)).toEqual([]);
    },
  );

  it('removes an incomplete download after a digest mismatch', async () => {
    metadata = { sha256: '0'.repeat(64) };
    expect(
      (
        await failureOf(
          prepareScannerEngine(new SonarHttpClient('https://sonarcloud.io', token), directory),
        )
      ).message,
    ).toContain('SHA-256 verification');
    expect(readdirSync(directory)).toEqual([]);
  });

  it.each([false, true])(
    'does not publish failed downloads (external URL: %s)',
    async (external) => {
      metadata = { sha256, ...(external ? { downloadUrl: 'https://cdn.example/engine' } : {}) };
      downloadStatus = 500;
      expect(
        (
          await failureOf(
            prepareScannerEngine(new SonarHttpClient('https://sonarcloud.io', token), directory),
          )
        ).message,
      ).toBeString();
      expect(readdirSync(directory)).toEqual([]);
    },
  );

  it('rejects a cross-origin redirect from the authenticated endpoint', async () => {
    fetchSpy.mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const headers = new Headers(init?.headers);
      requests.push({ url, headers });
      return Promise.resolve(
        headers.get('Accept') === 'application/json'
          ? Response.json(metadata)
          : new Response(null, {
              status: 302,
              headers: { Location: 'https://other.example/engine' },
            }),
      );
    });
    expect(
      (
        await failureOf(
          prepareScannerEngine(new SonarHttpClient('https://sonarcloud.io', token), directory),
        )
      ).message,
    ).toBeString();
    expect(requests.map(({ headers }) => headers.get('Accept'))).toEqual([
      'application/json',
      'application/octet-stream',
    ]);
    expect(requests.every(({ url }) => url === 'https://api.sonarcloud.io/analysis/engine')).toBe(
      true,
    );
    expect(readdirSync(directory)).toEqual([]);
  });

  it.each([false, true])(
    'allows an engine body to outlast the metadata timeout (external URL: %s)',
    async (external) => {
      metadata = { sha256, ...(external ? { downloadUrl: 'https://cdn.example/engine' } : {}) };
      const timeouts: { budget: number; controller: AbortController }[] = [];
      const timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation((budget) => {
        const controller = new AbortController();
        timeouts.push({ budget, controller });
        return controller.signal;
      });
      let finishBody: () => void = () => {};
      let bodyStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        bodyStarted = resolve;
      });
      fetchSpy.mockImplementation((input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (new Headers(init?.headers).get('Accept') === 'application/json')
          return Promise.resolve(Response.json(metadata));
        const stream = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
            finishBody = () => {
              controller.enqueue(engine);
              controller.close();
            };
          },
        });
        requests.push({ url, headers: new Headers(init?.headers) });
        bodyStarted();
        return Promise.resolve(new Response(stream));
      });
      try {
        const pending = prepareScannerEngine(
          new SonarHttpClient('https://sonarcloud.io', token),
          directory,
        );
        await started;
        for (const { budget, controller } of timeouts) {
          if (budget <= 31_000) controller.abort(new DOMException('Timed out', 'TimeoutError'));
        }
        finishBody();
        const path = await pending;
        expect(new Uint8Array(readFileSync(path))).toEqual(engine);
        expect(timeouts.map(({ budget }) => budget)).toEqual([30_000, 600_000]);
      } finally {
        timeoutSpy.mockRestore();
      }
    },
  );
});
