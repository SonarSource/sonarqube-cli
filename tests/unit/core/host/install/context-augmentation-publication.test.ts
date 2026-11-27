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
  existsSync,
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
import { buildCagPlatformSuffix } from '@/core/host/install/install-types.ts';
import { SONAR_CONTEXT_AUGMENTATION_SIGNATURES } from '@/core/host/install/signatures.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';

const releases = await import('@/core/host/install/sonarsource-releases.ts');
const utils = await import('@/core/host/install/install-utils.ts');
const tar = await import('@/core/io/tar.ts');
const state = await import('@/core/state/state-manager.ts');
let download = releases.downloadBinary;
let verify = releases.verifyPgpSignature;
let probe = utils.verifyInstallation;
let extract = tar.extractFileFromTarGz;
let record = state.recordInstalledDependency;
const originals = { download, verify, probe, extract, record };
void mock.module('@/core/host/install/sonarsource-releases.ts', () => ({
  ...releases,
  downloadBinary: (...args: Parameters<typeof download>) => download(...args),
  verifyPgpSignature: (...args: Parameters<typeof verify>) => verify(...args),
}));
void mock.module('@/core/host/install/install-utils.ts', () => ({
  ...utils,
  verifyInstallation: (...args: Parameters<typeof probe>) => probe(...args),
}));
void mock.module('@/core/io/tar.ts', () => ({
  ...tar,
  extractFileFromTarGz: (...args: Parameters<typeof extract>) => extract(...args),
}));
void mock.module('@/core/state/state-manager.ts', () => ({
  ...state,
  recordInstalledDependency: (...args: Parameters<typeof record>) => record(...args),
}));
const { resolveContextAugmentationBinary, buildLocalCagBinaryName } =
  await import('@/core/host/install/context-augmentation.ts');
const platform = detectPlatform();
const localName = buildLocalCagBinaryName(platform);
const signature = SONAR_CONTEXT_AUGMENTATION_SIGNATURES[buildCagPlatformSuffix(platform)];
let binDir: string;
let binaryPath: string;
let console: FakeConsole;
let records: string[];

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'context-publication-'));
  binaryPath = join(binDir, localName);
  console = new FakeConsole();
  records = [];
  download = (_url, path) => {
    writeFileSync(path, path.endsWith('.asc') ? signature : 'verified executable');
    return Promise.resolve();
  };
  verify = async () => {};
  probe = async () => {};
  extract = (bytes) => bytes;
  record = (_name, _version, path) => {
    records.push(path);
  };
});
afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
});
afterAll(() => {
  ({ download, verify, probe, extract, record } = originals);
});

describe('atomic Context binary publication', () => {
  it('publishes only after signature, permissions and probe complete', async () => {
    const started = barrier();
    const resume = barrier();
    verify = () => {
      expect(existsSync(binaryPath)).toBe(false);
      return Promise.resolve();
    };
    probe = async (path) => {
      expect(path).not.toBe(binaryPath);
      expect(readFileSync(path, 'utf8')).toBe('verified executable');
      if (platform.os !== 'windows') expect(statSync(path).mode & 0o111).toBe(0o111);
      started.release();
      await resume.promise;
    };
    const installing = resolveContextAugmentationBinary({ binDir, console });
    await started.promise;
    expect(existsSync(binaryPath)).toBe(false);
    expect(records).toEqual([]);
    resume.release();
    expect(await installing).toEqual({ binaryPath, freshlyInstalled: true });
    expect(readFileSync(binaryPath, 'utf8')).toBe('verified executable');
    expect(readdirSync(binDir)).toEqual([localName]);
    expect(records).toEqual([binaryPath]);
  });

  for (const failure of ['signature', 'probe', 'extraction']) {
    it(`keeps the existing binary when the forced refresh fails ${failure}`, async () => {
      writeFileSync(binaryPath, 'existing executable');
      const fail = () => {
        throw new Error(`${failure} failed`);
      };
      if (failure === 'signature') verify = fail;
      if (failure === 'probe') probe = fail;
      if (failure === 'extraction') extract = fail;
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        resolveContextAugmentationBinary({ binDir, console, force: true }),
      ).rejects.toThrow(`${failure} failed`);
      expect(readFileSync(binaryPath, 'utf8')).toBe('existing executable');
      expect(readdirSync(binDir)).toEqual([localName]);
      expect(records).toEqual([]);
    });
  }

  for (const failedSignature of [false, true]) {
    it(`leaves no staging files after a failed download, signature=${failedSignature}`, async () => {
      const started = barrier();
      const resume = barrier();
      download = async (_url, path) => {
        if (path.endsWith('.asc') === failedSignature) {
          writeFileSync(path, 'partial');
          started.release();
          throw new Error('download failed');
        }
        await resume.promise;
        writeFileSync(path, 'late download');
      };
      let settled = false;
      const installing = resolveContextAugmentationBinary({ binDir, console });
      void installing.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await started.promise;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(settled).toBe(false);
      expect(readdirSync(binDir)).toHaveLength(1);
      expect(readdirSync(binDir)[0]).toStartWith('.install-');
      expect(existsSync(binaryPath)).toBe(false);
      resume.release();
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(installing).rejects.toThrow('download failed');
      expect(readdirSync(binDir)).toEqual([]);
      expect(records).toEqual([]);
    });
  }

  it('keeps the first verified binary when two installs race', async () => {
    const started = barrier();
    const resume = barrier();
    let count = 0;
    download = (_url, path) => {
      writeFileSync(path, path.endsWith('.asc') ? signature : `executable ${++count}`);
      return Promise.resolve();
    };
    probe = async (path) => {
      if (readFileSync(path, 'utf8') === 'executable 1') {
        started.release();
        await resume.promise;
      }
    };
    const first = resolveContextAugmentationBinary({ binDir, console });
    await started.promise;
    expect(await resolveContextAugmentationBinary({ binDir, console })).toEqual({
      binaryPath,
      freshlyInstalled: true,
    });
    expect(readFileSync(binaryPath, 'utf8')).toBe('executable 2');
    resume.release();
    expect(await first).toEqual({ binaryPath, freshlyInstalled: false });
    expect(readFileSync(binaryPath, 'utf8')).toBe('executable 2');
    expect(readdirSync(binDir)).toEqual([localName]);
    expect(records).toEqual([binaryPath]);
  });
});
