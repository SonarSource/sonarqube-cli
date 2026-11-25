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

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';
import * as openpgp from 'openpgp';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { BinarySpec } from '@/core/host/install/binary.ts';
import {
  CONTAINER_SCANNER_BINARY_NAME,
  type PlatformInfo,
} from '@/core/host/install/install-types.ts';
import { SONAR_CONTAINER_SCANNER_VERSION } from '@/core/host/install/signatures.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';

const platformDetector = await import('@/core/host/environment/platform-detector.ts');
const releases = await import('@/core/host/install/sonarsource-releases.ts');
const installUtils = await import('@/core/host/install/install-utils.ts');
const stateManager = await import('@/core/state/state-manager.ts');

const realDetectPlatform = platformDetector.detectPlatform;
const realDownload = releases.downloadBinary;
const realVerify = releases.verifyBinarySignature;
const realProbe = installUtils.verifyInstallation;
const realEnsureBinDirectory = installUtils.ensureBinDirectory;
const realRecord = stateManager.recordInstalledDependency;

let detectPlatformImpl: typeof realDetectPlatform = realDetectPlatform;
let downloadImpl: typeof realDownload = realDownload;
let verifyImpl: typeof realVerify = realVerify;
let probeImpl: typeof realProbe = realProbe;
let ensureBinDirectoryImpl: typeof realEnsureBinDirectory = realEnsureBinDirectory;
let recordImpl: typeof realRecord = realRecord;

void mock.module('@/core/host/environment/platform-detector.ts', () => ({
  ...platformDetector,
  detectPlatform: () => detectPlatformImpl(),
}));
void mock.module('@/core/host/install/sonarsource-releases.ts', () => ({
  ...releases,
  downloadBinary: (...args: Parameters<typeof downloadImpl>) => downloadImpl(...args),
  verifyBinarySignature: (...args: Parameters<typeof verifyImpl>) => verifyImpl(...args),
}));
void mock.module('@/core/host/install/install-utils.ts', () => ({
  ...installUtils,
  ensureBinDirectory: (...args: Parameters<typeof ensureBinDirectoryImpl>) =>
    ensureBinDirectoryImpl(...args),
  verifyInstallation: (...args: Parameters<typeof probeImpl>) => probeImpl(...args),
}));
void mock.module('@/core/state/state-manager.ts', () => ({
  ...stateManager,
  recordInstalledDependency: (...args: Parameters<typeof recordImpl>) => recordImpl(...args),
}));

const { buildLocalBinaryName, installBinary, resolveBinaryArtifact } =
  await import('@/core/host/install/binary.ts');
const { CONTAINER_SCANNER_SPEC, installContainerScanner } =
  await import('@/core/host/install/container-scanner.ts');

const LINUX_X86_64: PlatformInfo = { os: 'linux', arch: 'x86-64', extension: '' };

afterAll(() => {
  detectPlatformImpl = realDetectPlatform;
  downloadImpl = realDownload;
  verifyImpl = realVerify;
  probeImpl = realProbe;
  ensureBinDirectoryImpl = realEnsureBinDirectory;
  recordImpl = realRecord;
});

describe('container scanner distribution', () => {
  it.each([
    ['linux', 'x86-64', 'x64', 'bin', ''],
    ['linux', 'arm64', 'arm64', 'bin', ''],
    ['macos', 'arm64', 'arm64', 'bin', ''],
    ['windows', 'x86-64', 'x64', 'exe', '.exe'],
  ])(
    'resolves the signed %s %s artifact and keeps its local cache name',
    (os, arch, downloadArch, suffix, extension) => {
      const platform = { os, arch, extension };
      const artifact = resolveBinaryArtifact(CONTAINER_SCANNER_SPEC, platform);
      const artifactKey = `${os}-${downloadArch}`;
      const expectedFilename = `${CONTAINER_SCANNER_BINARY_NAME}-${SONAR_CONTAINER_SCANNER_VERSION}-${artifactKey}.${suffix}`;

      expect(artifact.platformKey).toBe(artifactKey);
      expect(artifact.filename).toBe(expectedFilename);
      expect(artifact.url).toEndWith(
        `/CommercialDistribution/${CONTAINER_SCANNER_BINARY_NAME}/${expectedFilename}`,
      );
      expect(CONTAINER_SCANNER_SPEC.signatures[artifactKey]).toStartWith(
        '-----BEGIN PGP SIGNATURE-----',
      );
      expect(buildLocalBinaryName(CONTAINER_SCANNER_SPEC, platform)).toBe(
        `${CONTAINER_SCANNER_BINARY_NAME}-${SONAR_CONTAINER_SCANNER_VERSION}-${os}-${arch}${extension}`,
      );
    },
  );

  it('throws CommandFailedError when the platform has no published artifact', () => {
    expect(() =>
      resolveBinaryArtifact(CONTAINER_SCANNER_SPEC, { os: 'macos', arch: 'x86-64', extension: '' }),
    ).toThrow(CommandFailedError);
    expect(() =>
      resolveBinaryArtifact(CONTAINER_SCANNER_SPEC, { os: 'macos', arch: 'x86-64', extension: '' }),
    ).toThrow(`${CONTAINER_SCANNER_BINARY_NAME} is not available for platform 'macos-x64'.`);
  });
});

describe('container scanner installation lifecycle', () => {
  const validBytes = Buffer.from('signed-container-scanner-binary');
  let signedSpec: BinarySpec;
  let tempBinDir: string;
  let fakeConsole: FakeConsole;

  beforeAll(async () => {
    const { privateKey, publicKey } = await openpgp.generateKey({
      type: 'ecc',
      curve: 'curve25519Legacy',
      userIDs: [{ name: 'Container Scanner Test', email: 'test@example.com' }],
    });
    const privateKeyObj = await openpgp.readPrivateKey({ armoredKey: privateKey });
    const message = await openpgp.createMessage({ binary: validBytes });
    const signature = (await openpgp.sign({
      message,
      signingKeys: privateKeyObj,
      detached: true,
    })) as string;

    signedSpec = {
      name: CONTAINER_SCANNER_BINARY_NAME,
      version: '2.0.0',
      distPrefix: CONTAINER_SCANNER_SPEC.distPrefix,
      signatures: { 'linux-x64': signature },
      publicKey,
      extensions: { 'linux-x64': 'bin' },
      platformNaming: 'x64',
    };
  });

  beforeEach(() => {
    tempBinDir = mkdtempSync(join(tmpdir(), 'container-scanner-install-'));
    fakeConsole = new FakeConsole();
    detectPlatformImpl = () => LINUX_X86_64;
    ensureBinDirectoryImpl = (dir?: string) => realEnsureBinDirectory(dir ?? tempBinDir);
    probeImpl = async () => {};
    recordImpl = () => {};
    downloadImpl = (_url, destPath) => {
      writeFileSync(destPath, validBytes);
      return Promise.resolve();
    };
    verifyImpl = realVerify;
  });

  afterEach(() => {
    rmSync(tempBinDir, { recursive: true, force: true });
  });

  it('installs on demand via stderr, maps x86-64 to x64 on download/verify, and reuses the cache', async () => {
    const downloadedUrls: string[] = [];
    const verifiedPlatformKeys: string[] = [];
    downloadImpl = (url, destPath) => {
      downloadedUrls.push(url);
      writeFileSync(destPath, validBytes);
      return Promise.resolve();
    };
    verifyImpl = (_name, _path, platformKey) => {
      verifiedPlatformKeys.push(platformKey);
      return Promise.resolve();
    };

    const textSpy = spyOn(fakeConsole, 'text');
    const spinnerSpy = spyOn(fakeConsole, 'withSpinner');

    const firstPath = await installContainerScanner(fakeConsole);
    const expectedPath = join(
      tempBinDir,
      `${CONTAINER_SCANNER_BINARY_NAME}-${SONAR_CONTAINER_SCANNER_VERSION}-linux-x86-64`,
    );

    expect(firstPath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(downloadedUrls).toHaveLength(1);
    expect(downloadedUrls[0]).toEndWith(
      `/${CONTAINER_SCANNER_BINARY_NAME}-${SONAR_CONTAINER_SCANNER_VERSION}-linux-x64.bin`,
    );
    expect(verifiedPlatformKeys).toEqual(['linux-x64']);
    expect(textSpy).toHaveBeenCalled();
    for (const call of textSpy.mock.calls) {
      expect(call[2]).toBe('stderr');
    }
    expect(spinnerSpy).toHaveBeenCalled();
    for (const call of spinnerSpy.mock.calls) {
      expect(call[2]).toBe('stderr');
    }

    const secondPath = await installContainerScanner(fakeConsole);
    expect(secondPath).toBe(expectedPath);
    expect(downloadedUrls).toHaveLength(1);
    expect(verifiedPlatformKeys).toEqual(['linux-x64']);
  });

  it('verifies a real PGP signature under the x64 key and removes older versions on version bump', async () => {
    const stalePath = join(tempBinDir, `${CONTAINER_SCANNER_BINARY_NAME}-1.0.0-linux-x86-64`);
    writeFileSync(stalePath, 'stale-version');

    const result = await installBinary(signedSpec, {
      console: fakeConsole,
      binDir: tempBinDir,
      channel: 'stderr',
    });

    const expectedName = `${CONTAINER_SCANNER_BINARY_NAME}-2.0.0-linux-x86-64`;
    expect(result).toEqual({
      binaryPath: join(tempBinDir, expectedName),
      freshlyInstalled: true,
    });
    expect(existsSync(stalePath)).toBe(false);
    expect(readdirSync(tempBinDir)).toEqual([expectedName]);
    expect(readFileSync(result.binaryPath)).toEqual(validBytes);
  });

  it('rejects a tampered binary via real signature verification without publishing to cache', async () => {
    downloadImpl = (_url, destPath) => {
      writeFileSync(destPath, Buffer.from('tampered-container-scanner-binary'));
      return Promise.resolve();
    };

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      installBinary(signedSpec, {
        console: fakeConsole,
        binDir: tempBinDir,
        channel: 'stderr',
      }),
    ).rejects.toThrow('Binary signature verification failed');

    expect(readdirSync(tempBinDir)).toEqual([]);
  });
});
