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

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { detectPlatform } from '@/core/host/environment/platform-detector.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';

const releases = await import('@/core/host/install/sonarsource-releases.ts');
const utils = await import('@/core/host/install/install-utils.ts');
const realDownload = releases.downloadBinary;
const realVerify = releases.verifyBinarySignature;
const realProbe = utils.verifyInstallation;
const stateManager = await import('@/core/state/state-manager.ts');
const realRecord = stateManager.recordInstalledDependency;
let record: typeof realRecord = realRecord;
void mock.module('@/core/state/state-manager.ts', () => ({
  ...stateManager,
  recordInstalledDependency: (...args: Parameters<typeof record>) => record(...args),
}));
let download: typeof releases.downloadBinary = realDownload;
let verify: typeof releases.verifyBinarySignature = releases.verifyBinarySignature;
let probe: typeof utils.verifyInstallation = utils.verifyInstallation;
void mock.module('@/core/host/install/sonarsource-releases.ts', () => ({
  ...releases,
  downloadBinary: (...args: Parameters<typeof download>) => download(...args),
  verifyBinarySignature: (...args: Parameters<typeof verify>) => verify(...args),
}));
void mock.module('@/core/host/install/install-utils.ts', () => ({
  ...utils,
  verifyInstallation: (...args: Parameters<typeof probe>) => probe(...args),
}));
const { installBinary, buildLocalBinaryName, resolveBinaryPath } =
  await import('@/core/host/install/binary.ts');
const platform = detectPlatform();
const spec = {
  name: 'test-dependency',
  version: '1.0',
  distPrefix: 'test',
  signatures: {},
  publicKey: '',
  extensions: { [`${platform.os}-${platform.arch}`]: 'exe' as const },
};
let binDir: string;
let binaryPath: string;
let console: FakeConsole;

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'binary-publication-'));
  binaryPath = join(binDir, buildLocalBinaryName(spec, platform));
  console = new FakeConsole();
  record = () => {};
  download = (_url, path) => {
    writeFileSync(path, 'verified executable');
    return Promise.resolve();
  };
  verify = async () => {};
  probe = async () => {};
});
afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
});
afterAll(() => {
  download = realDownload;
  verify = realVerify;
  probe = realProbe;
  record = realRecord;
});

describe('atomic dependency publication', () => {
  it('keeps the final path absent until signature and probe complete', async () => {
    const verificationStarted = barrier();
    const verified = barrier();
    const probeStarted = barrier();
    const probed = barrier();
    verify = async (_name, path) => {
      expect(path).not.toBe(binaryPath);
      expect(readFileSync(path, 'utf8')).toBe('verified executable');
      if (platform.os !== 'windows') expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
      verificationStarted.release();
      await verified.promise;
    };
    probe = async (path) => {
      if (platform.os !== 'windows') expect(statSync(path).mode & 0o111).toBe(0o111);
      probeStarted.release();
      await probed.promise;
    };
    const installation = installBinary(spec, { binDir, console });
    await verificationStarted.promise;
    expect(resolveBinaryPath(spec, binDir)).toBeNull();
    verified.release();
    await probeStarted.promise;
    expect(existsSync(binaryPath)).toBe(false);
    probed.release();
    expect(await installation).toEqual({ binaryPath, freshlyInstalled: true });
    expect(readFileSync(binaryPath, 'utf8')).toBe('verified executable');
    expect(readdirSync(binDir)).toEqual([buildLocalBinaryName(spec, platform)]);
  });

  it('lets concurrent publishers keep the first verified executable', async () => {
    const started = barrier();
    const resume = barrier();
    let count = 0;
    download = (_url, path) => {
      writeFileSync(path, `executable ${++count}`);
      return Promise.resolve();
    };
    verify = async (_name, path) => {
      if (readFileSync(path, 'utf8') === 'executable 1') {
        started.release();
        await resume.promise;
      }
    };
    const first = installBinary(spec, { binDir, console });
    await started.promise;
    expect(existsSync(binaryPath)).toBe(false);
    const second = await installBinary(spec, { binDir, console });
    expect(second.freshlyInstalled).toBe(true);
    expect(readFileSync(binaryPath, 'utf8')).toBe('executable 2');
    resume.release();
    expect((await first).freshlyInstalled).toBe(false);
    expect(readFileSync(binaryPath, 'utf8')).toBe('executable 2');
    expect(readdirSync(binDir)).toEqual([buildLocalBinaryName(spec, platform)]);
  });

  for (const failure of ['download', 'signature', 'probe']) {
    for (const existing of [false, true]) {
      it(`cleans staging after ${failure} failure and preserves existing=${existing}`, async () => {
        if (existing) writeFileSync(binaryPath, 'existing executable');
        const fail = () => Promise.reject(new Error(`${failure} failed`));
        if (failure === 'download')
          download = async (_url, path) => {
            writeFileSync(path, 'partial');
            await fail();
          };
        if (failure === 'signature') verify = fail;
        if (failure === 'probe') probe = fail;
        // eslint-disable-next-line @typescript-eslint/await-thenable
        await expect(installBinary(spec, { binDir, console, force: existing })).rejects.toThrow(
          `${failure} failed`,
        );
        expect(existsSync(binaryPath)).toBe(existing);
        if (existing) expect(readFileSync(binaryPath, 'utf8')).toBe('existing executable');
        expect(readdirSync(binDir)).toEqual(existing ? [buildLocalBinaryName(spec, platform)] : []);
      });
    }
  }

  it('keeps an existing executable visible while a forced refresh is verified', async () => {
    writeFileSync(binaryPath, 'existing executable');
    const started = barrier();
    const resume = barrier();
    verify = async () => {
      started.release();
      await resume.promise;
    };
    const refreshing = installBinary(spec, { binDir, console, force: true });
    await started.promise;
    expect(await installBinary(spec, { binDir, console })).toEqual({
      binaryPath,
      freshlyInstalled: false,
    });
    expect(readFileSync(binaryPath, 'utf8')).toBe('existing executable');
    resume.release();
    expect((await refreshing).freshlyInstalled).toBe(true);
    expect(readFileSync(binaryPath, 'utf8')).toBe('verified executable');
    expect(readdirSync(binDir)).toEqual([buildLocalBinaryName(spec, platform)]);
  });

  it('does not unlink a destination when atomic replacement fails', async () => {
    mkdirSync(binaryPath);
    writeFileSync(join(binaryPath, 'preserved'), 'keep');
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(installBinary(spec, { binDir, console, force: true })).rejects.toThrow();
    expect(readFileSync(join(binaryPath, 'preserved'), 'utf8')).toBe('keep');
    expect(readdirSync(binDir)).toEqual([buildLocalBinaryName(spec, platform)]);
  });

  it.skipIf(platform.os !== 'windows')(
    'preserves a running Windows executable when replacement is denied',
    async () => {
      copyFileSync(process.execPath, binaryPath);
      const original = readFileSync(binaryPath);
      const child = Bun.spawn(
        [binaryPath, '-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      try {
        const reader = child.stdout.getReader();
        const ready = await reader.read();
        reader.releaseLock();
        expect(new TextDecoder().decode(ready.value)).toContain('ready');
        // eslint-disable-next-line @typescript-eslint/await-thenable
        await expect(installBinary(spec, { binDir, console, force: true })).rejects.toThrow();
        expect(readFileSync(binaryPath)).toEqual(original);
        expect(readdirSync(binDir)).toEqual([buildLocalBinaryName(spec, platform)]);
      } finally {
        child.kill();
        await child.exited;
      }
    },
  );
});
