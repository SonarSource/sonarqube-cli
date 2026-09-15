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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  compileTargetMatchesHost,
  compileTargetTarballUrl,
  downloadCompileTargetExecutable,
  npmPackageForCompileTarget,
  REPOX_NPM_REGISTRY,
} from '../../../build-scripts/compile-target-runtime.ts';

describe('npmPackageForCompileTarget()', () => {
  it('maps CI compile targets to the @oven npm package names bun embeds', () => {
    expect(npmPackageForCompileTarget('bun-linux-x64')).toBe('bun-linux-x64');
    expect(npmPackageForCompileTarget('bun-linux-arm64')).toBe('bun-linux-aarch64');
    expect(npmPackageForCompileTarget('bun-darwin-arm64')).toBe('bun-darwin-aarch64');
    expect(npmPackageForCompileTarget('bun-windows-x64')).toBe('bun-windows-x64');
  });

  it('returns undefined for an unknown target', () => {
    expect(npmPackageForCompileTarget('bun-linux-ppc64')).toBeUndefined();
  });
});

describe('compileTargetTarballUrl()', () => {
  it('builds the npm tarball path under the Repox virtual registry', () => {
    expect(compileTargetTarballUrl(REPOX_NPM_REGISTRY, 'bun-linux-aarch64', '1.4.0')).toBe(
      'https://repox.jfrog.io/artifactory/api/npm/npm/@oven/bun-linux-aarch64/-/bun-linux-aarch64-1.4.0.tgz',
    );
  });

  it('strips a trailing slash from the registry URL', () => {
    expect(compileTargetTarballUrl(`${REPOX_NPM_REGISTRY}/`, 'bun-windows-x64', '1.4.0')).toBe(
      'https://repox.jfrog.io/artifactory/api/npm/npm/@oven/bun-windows-x64/-/bun-windows-x64-1.4.0.tgz',
    );
  });
});

describe('compileTargetMatchesHost()', () => {
  it('matches the current OS and architecture', () => {
    const os =
      process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

    expect(compileTargetMatchesHost(`bun-${os}-${arch}`)).toBe(true);
    expect(compileTargetMatchesHost('bun-plan9-x64')).toBe(false);
  });
});

describe('downloadCompileTargetExecutable()', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it('downloads the tarball with a bearer token and returns the extracted bun binary', async () => {
    const staging = mkdtempSync(join(tmpdir(), 'compile-target-fixture-'));
    cleanups.push(() => rmSync(staging, { recursive: true, force: true }));
    mkdirSync(join(staging, 'package', 'bin'), { recursive: true });
    writeFileSync(join(staging, 'package', 'bin', 'bun'), 'fake-bun-runtime');
    const tarballPath = join(staging, 'pkg.tgz');
    const packed = Bun.spawnSync(['tar', '-czf', tarballPath, '-C', staging, 'package']);
    expect(packed.exitCode).toBe(0);

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        if (req.headers.get('authorization') !== 'Bearer test-token') {
          return new Response('unauthorized', { status: 401 });
        }
        if (
          new URL(req.url).pathname !== '/@oven/bun-linux-aarch64/-/bun-linux-aarch64-1.4.0.tgz'
        ) {
          return new Response('not found', { status: 404 });
        }
        return new Response(Bun.file(tarballPath));
      },
    });
    cleanups.push(() => {
      void server.stop(true);
    });

    const downloaded = await downloadCompileTargetExecutable({
      target: 'bun-linux-arm64',
      bunVersion: '1.4.0',
      registryUrl: `http://127.0.0.1:${server.port}`,
      token: 'test-token',
    });
    cleanups.push(downloaded.cleanup);

    expect(readFileSync(downloaded.executablePath, 'utf8')).toBe('fake-bun-runtime');
  });

  it('fails without leaking the token when the registry rejects the download', async () => {
    const fetchImpl = (): Promise<Response> =>
      Promise.resolve(new Response('nope', { status: 401 }));

    try {
      await downloadCompileTargetExecutable({
        target: 'bun-linux-arm64',
        bunVersion: '1.4.0',
        registryUrl: REPOX_NPM_REGISTRY,
        token: 'super-secret-token',
        fetchImpl,
      });
      throw new Error('expected the download to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        'Failed to download @oven/bun-linux-aarch64@1.4.0 from Repox: HTTP 401',
      );
      expect((error as Error).message).not.toContain('super-secret-token');
    }
  });
});
