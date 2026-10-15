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
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { mdmInstall, mdmRemove, mdmRollback, mdmUpdate } from '@/commands/mdm';
import { parseArtifactBaseUrlOption, parseVersionOption } from '@/commands/mdm/mdm-artifact.ts';
import type { MdmEnvironment } from '@/commands/mdm/mdm-environment.ts';
import { standaloneBinaryPath } from '@/commands/mdm/mdm-environment.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

function fakeBinaryScript(version: string): string {
  return `#!/bin/sh\necho "${version}"\n`;
}

describe.skipIf(process.platform === 'win32')('sonar mdm', () => {
  let workDir: string;
  let env: MdmEnvironment;
  let userHomes: string[];
  let server: ReturnType<typeof Bun.serve>;
  let served: Map<string, string>;
  let requestedPaths: string[];
  let console: FakeConsole;
  let ctx: CommandInvocationContext;

  function publish(version: string, checksum?: string): void {
    const { os, arch } = detectPlatform();
    const body = fakeBinaryScript(version);
    const path = `/Distribution/sonarqube-cli/${version}/${os}/sonarqube-cli-${version}-${os}-${arch}.bin`;
    served.set(path, body);
    served.set(
      `${path}.sha256`,
      `${checksum ?? createHash('sha256').update(body).digest('hex')}  file\n`,
    );
  }

  function cdnUrl(): string {
    return `http://127.0.0.1:${server.port}/Distribution/sonarqube-cli`;
  }

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'mdm-test-'));
    userHomes = [join(workDir, 'home-a'), join(workDir, 'home-b')];
    env = {
      binaryPath: join(workDir, 'bin', 'sonar'),
      listUserHomes: () => Promise.resolve(userHomes),
    };
    served = new Map();
    requestedPaths = [];
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const { pathname } = new URL(req.url);
        requestedPaths.push(pathname);
        if (pathname === '/Distribution/sonarqube-cli/stable.version') {
          return new Response(served.get('stable') ?? '', {
            status: served.has('stable') ? 200 : 404,
          });
        }
        const body = served.get(pathname);
        return body === undefined ? new Response('missing', { status: 404 }) : new Response(body);
      },
    });
    console = new FakeConsole();
    ctx = new CommandInvocationContext(console);
  });

  afterEach(async () => {
    await server.stop(true);
    rmSync(workDir, { recursive: true, force: true });
  });

  describe('option parsing', () => {
    it('rejects versions with shell metacharacters', () => {
      expect(() => parseVersionOption('1.2.3$(id)')).toThrow();
      expect(parseVersionOption('1.2.3.456')).toBe('1.2.3.456');
    });

    it('accepts https and loopback http CDN URLs and strips the trailing slash', () => {
      expect(parseArtifactBaseUrlOption('https://mirror.example.com/')).toBe(
        'https://mirror.example.com',
      );
      expect(parseArtifactBaseUrlOption('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
      expect(() => parseArtifactBaseUrlOption('http://mirror.example.com')).toThrow();
      expect(() => parseArtifactBaseUrlOption('not a url')).toThrow();
    });
  });

  describe('update', () => {
    it('installs the stable version when nothing is installed yet', async () => {
      served.set('stable', '2.0.0\n');
      publish('2.0.0');

      await mdmUpdate({ artifactBaseUrl: cdnUrl() }, ctx, env);

      expect(readFileSync(env.binaryPath, 'utf8')).toBe(fakeBinaryScript('2.0.0'));
    });

    it('skips the download when already at the target version', async () => {
      served.set('stable', '2.0.0\n');
      publish('2.0.0');
      await mdmUpdate({ artifactBaseUrl: cdnUrl() }, ctx, env);
      requestedPaths.length = 0;

      await mdmUpdate({ artifactBaseUrl: cdnUrl() }, ctx, env);

      expect(requestedPaths).toEqual(['/Distribution/sonarqube-cli/stable.version']);
    });

    it('re-downloads when forced', async () => {
      publish('2.0.0');
      await mdmUpdate({ approvedVersion: '2.0.0', artifactBaseUrl: cdnUrl() }, ctx, env);
      requestedPaths.length = 0;

      await mdmUpdate(
        { approvedVersion: '2.0.0', force: true, artifactBaseUrl: cdnUrl() },
        ctx,
        env,
      );

      expect(requestedPaths.some((path) => path.endsWith('.bin'))).toBe(true);
    });

    it('replaces an older binary with the approved version and leaves no temp files', async () => {
      publish('1.0.0');
      publish('3.0.0');
      await mdmRollback({ version: '1.0.0', artifactBaseUrl: cdnUrl() }, ctx, env);

      await mdmUpdate({ approvedVersion: '3.0.0', artifactBaseUrl: cdnUrl() }, ctx, env);

      expect(readFileSync(env.binaryPath, 'utf8')).toBe(fakeBinaryScript('3.0.0'));
      expect(existsSync(`${env.binaryPath}.new`)).toBe(false);
    });

    it('aborts and keeps the installed binary when the checksum does not match', async () => {
      publish('1.0.0');
      await mdmRollback({ version: '1.0.0', artifactBaseUrl: cdnUrl() }, ctx, env);
      publish('2.0.0', 'f'.repeat(64));

      expect(
        await rejectionMessage(
          mdmUpdate({ approvedVersion: '2.0.0', artifactBaseUrl: cdnUrl() }, ctx, env),
        ),
      ).toContain('SHA256 mismatch');

      expect(readFileSync(env.binaryPath, 'utf8')).toBe(fakeBinaryScript('1.0.0'));
    });

    it('installs with mode 755 so regular users can read and run it', async () => {
      publish('2.0.0');

      await mdmUpdate({ approvedVersion: '2.0.0', artifactBaseUrl: cdnUrl() }, ctx, env);

      expect(statSync(env.binaryPath).mode & 0o777).toBe(0o755);
    });

    it('restores mode 755 on an existing binary even when the update is a no-op', async () => {
      publish('2.0.0');
      await mdmUpdate({ approvedVersion: '2.0.0', artifactBaseUrl: cdnUrl() }, ctx, env);
      chmodSync(env.binaryPath, 0o700);

      await mdmUpdate({ approvedVersion: '2.0.0', artifactBaseUrl: cdnUrl() }, ctx, env);

      expect(statSync(env.binaryPath).mode & 0o777).toBe(0o755);
    });

    it('proceeds with a warning when the checksum file is missing and that is allowed', async () => {
      publish('2.0.0');
      served.delete([...served.keys()].find((key) => key.endsWith('.sha256')) as string);

      await mdmUpdate(
        { approvedVersion: '2.0.0', artifactBaseUrl: cdnUrl(), allowMissingChecksum: true },
        ctx,
        env,
      );

      expect(readFileSync(env.binaryPath, 'utf8')).toBe(fakeBinaryScript('2.0.0'));
      expect(console.calls.some((call) => call.method === 'warn')).toBe(true);
    });

    it('still aborts on a checksum mismatch when a missing checksum is allowed', async () => {
      publish('2.0.0', 'f'.repeat(64));

      const message = await rejectionMessage(
        mdmUpdate(
          { approvedVersion: '2.0.0', artifactBaseUrl: cdnUrl(), allowMissingChecksum: true },
          ctx,
          env,
        ),
      );

      expect(message).toContain('SHA256 mismatch');
      expect(existsSync(env.binaryPath)).toBe(false);
    });

    it('aborts when the checksum file is missing', async () => {
      publish('2.0.0');
      served.delete([...served.keys()].find((key) => key.endsWith('.sha256')) as string);

      expect(
        await rejectionMessage(
          mdmUpdate({ approvedVersion: '2.0.0', artifactBaseUrl: cdnUrl() }, ctx, env),
        ),
      ).not.toBe('');

      expect(existsSync(env.binaryPath)).toBe(false);
    });
  });

  describe('rollback', () => {
    it('always replaces the binary, even when already at that version', async () => {
      publish('1.0.0');
      await mdmRollback({ version: '1.0.0', artifactBaseUrl: cdnUrl() }, ctx, env);
      requestedPaths.length = 0;

      await mdmRollback({ version: '1.0.0', artifactBaseUrl: cdnUrl() }, ctx, env);

      expect(requestedPaths.some((path) => path.endsWith('.bin'))).toBe(true);
    });

    it('fails when the version is not published', async () => {
      expect(
        await rejectionMessage(
          mdmRollback({ version: '9.9.9', artifactBaseUrl: cdnUrl() }, ctx, env),
        ),
      ).toContain('Could not download');
    });
  });

  describe('install', () => {
    function seedStandalone(home: string): string {
      const standalone = standaloneBinaryPath(home);
      mkdirSync(join(standalone, '..'), { recursive: true });
      writeFileSync(standalone, 'standalone');
      return standalone;
    }

    it('copies the running binary and symlinks existing standalone installs', async () => {
      const [homeWithStandalone] = userHomes;
      const standalone = seedStandalone(homeWithStandalone);
      const sourceBinary = join(workDir, 'source-sonar');
      writeFileSync(sourceBinary, fakeBinaryScript('4.0.0'));
      const originalExecPath = process.execPath;
      Object.defineProperty(process, 'execPath', { value: sourceBinary, configurable: true });

      try {
        await mdmInstall({}, ctx, env);
      } finally {
        Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
      }

      expect(readFileSync(env.binaryPath, 'utf8')).toBe(fakeBinaryScript('4.0.0'));
      expect(lstatSync(standalone).isSymbolicLink()).toBe(true);
      expect(readlinkSync(standalone)).toBe(env.binaryPath);
      expect(existsSync(standaloneBinaryPath(userHomes[1]))).toBe(false);
    });
  });

  describe('install flags', () => {
    it('--skip-if-present leaves an existing binary untouched and restores its mode', async () => {
      mkdirSync(join(env.binaryPath, '..'), { recursive: true });
      writeFileSync(env.binaryPath, fakeBinaryScript('1.0.0'), { mode: 0o700 });

      await mdmInstall({ skipIfPresent: true }, ctx, env);

      expect(readFileSync(env.binaryPath, 'utf8')).toBe(fakeBinaryScript('1.0.0'));
      expect(statSync(env.binaryPath).mode & 0o777).toBe(0o755);
    });

    it('--skip-standalone-links installs without touching standalone installs', async () => {
      const standalone = standaloneBinaryPath(userHomes[0]);
      mkdirSync(join(standalone, '..'), { recursive: true });
      writeFileSync(standalone, 'standalone');
      const sourceBinary = join(workDir, 'source-sonar');
      writeFileSync(sourceBinary, fakeBinaryScript('4.0.0'));
      const originalExecPath = process.execPath;
      Object.defineProperty(process, 'execPath', { value: sourceBinary, configurable: true });

      try {
        await mdmInstall({ skipStandaloneLinks: true }, ctx, env);
      } finally {
        Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
      }

      expect(readFileSync(env.binaryPath, 'utf8')).toBe(fakeBinaryScript('4.0.0'));
      expect(lstatSync(standalone).isSymbolicLink()).toBe(false);
    });
  });

  describe('remove', () => {
    it('--mdm-binary-only keeps standalone installs and other copies on PATH', async () => {
      publish('1.0.0');
      await mdmRollback({ version: '1.0.0', artifactBaseUrl: cdnUrl() }, ctx, env);
      const standalone = standaloneBinaryPath(userHomes[0]);
      mkdirSync(join(standalone, '..'), { recursive: true });
      writeFileSync(standalone, 'standalone');
      const otherDir = join(workDir, 'other-bin');
      mkdirSync(otherDir);
      const other = join(otherDir, 'sonar');
      writeFileSync(other, fakeBinaryScript('0.9.0'), { mode: 0o755 });
      const originalPath = process.env.PATH;
      process.env.PATH = otherDir;

      try {
        await mdmRemove({ mdmBinaryOnly: true }, ctx, env);
      } finally {
        process.env.PATH = originalPath;
      }

      expect(existsSync(env.binaryPath)).toBe(false);
      expect(existsSync(standalone)).toBe(true);
      expect(existsSync(other)).toBe(true);
    });

    it('deletes the binary and every standalone install, including symlinks', async () => {
      publish('1.0.0');
      await mdmRollback({ version: '1.0.0', artifactBaseUrl: cdnUrl() }, ctx, env);
      const regular = standaloneBinaryPath(userHomes[0]);
      mkdirSync(join(regular, '..'), { recursive: true });
      writeFileSync(regular, 'standalone');
      const linked = standaloneBinaryPath(userHomes[1]);
      mkdirSync(join(linked, '..'), { recursive: true });
      symlinkSync(env.binaryPath, linked);
      const originalPath = process.env.PATH;
      process.env.PATH = join(workDir, 'empty');

      try {
        await mdmRemove({}, ctx, env);
      } finally {
        process.env.PATH = originalPath;
      }

      expect(existsSync(env.binaryPath)).toBe(false);
      expect(existsSync(regular)).toBe(false);
      expect(lstatSync(linked, { throwIfNoEntry: false })).toBeUndefined();
    });

    it('refuses to delete a PATH entry that does not look like the CLI', async () => {
      const binDir = join(workDir, 'path-bin');
      mkdirSync(binDir);
      const impostor = join(binDir, 'sonar');
      writeFileSync(impostor, '#!/bin/sh\necho "not a version"\n', { mode: 0o755 });
      const originalPath = process.env.PATH;
      process.env.PATH = binDir;

      try {
        expect(await rejectionMessage(mdmRemove({}, ctx, env))).toContain(
          'does not look like the SonarQube CLI',
        );
      } finally {
        process.env.PATH = originalPath;
      }

      expect(existsSync(impostor)).toBe(true);
    });
  });
});
