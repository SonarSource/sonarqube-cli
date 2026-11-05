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

import { beforeAll, describe, expect, it } from 'bun:test';
import * as openpgp from 'openpgp';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { PlatformInfo } from '@/core/host/install/install-types.ts';
import { SONAR_SCANNER_CLI_SIGNATURES } from '@/core/host/install/signatures.ts';
import {
  scannerArchive,
  SONAR_SCANNER_VERSION,
  verifyScannerArchive,
} from '@/core/host/install/sonar-scanner.ts';

const LINUX: PlatformInfo = { os: 'linux', arch: 'x86-64', extension: '' };
const ARCHIVE = Buffer.from('pretend this is the scanner zip');

describe('scannerArchive', () => {
  it.each([
    [{ os: 'linux', arch: 'x86-64' }, 'linux-x64'],
    [{ os: 'linux', arch: 'arm64' }, 'linux-aarch64'],
    [{ os: 'macos', arch: 'x86-64' }, 'macosx-x64'],
    [{ os: 'macos', arch: 'arm64' }, 'macosx-aarch64'],
    [{ os: 'windows', arch: 'x86-64' }, 'windows-x64'],
  ])('maps %o to the %s archive', (platform, suffix) => {
    const archive = scannerArchive({ ...platform, extension: '' });

    expect(archive.directoryName).toBe(`sonar-scanner-${SONAR_SCANNER_VERSION}-${suffix}`);
    expect(archive.url.endsWith(`sonar-scanner-cli-${SONAR_SCANNER_VERSION}-${suffix}.zip`)).toBe(
      true,
    );
  });

  it('rejects an unsupported platform', () => {
    expect(() => scannerArchive({ os: 'freebsd', arch: 'x86-64', extension: '' })).toThrow(
      CommandFailedError,
    );
  });

  it('has a pinned signature for every platform it can download for', () => {
    for (const platform of [
      'linux-x86-64',
      'linux-arm64',
      'macos-x86-64',
      'macos-arm64',
      'windows-x86-64',
    ]) {
      expect(SONAR_SCANNER_CLI_SIGNATURES[platform]).toContain('BEGIN PGP SIGNATURE');
    }
  });
});

describe('verifyScannerArchive', () => {
  let publicKey: string;
  let signatures: Record<string, string>;

  beforeAll(async () => {
    const pair = await openpgp.generateKey({
      type: 'rsa',
      rsaBits: 2048,
      userIDs: [{ name: 'Test', email: 'test@example.com' }],
    });
    publicKey = pair.publicKey;
    const signingKeys = await openpgp.readPrivateKey({ armoredKey: pair.privateKey });
    const message = await openpgp.createMessage({ binary: ARCHIVE });
    signatures = {
      'linux-x86-64': (await openpgp.sign({
        message,
        signingKeys,
        detached: true,
      })) as string,
    };
  });

  it('accepts an archive that matches the pinned signature', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      verifyScannerArchive(ARCHIVE, LINUX, signatures, publicKey),
    ).resolves.toBeUndefined();
  });

  it('rejects a tampered archive', async () => {
    const tampered = Buffer.from('not the scanner zip');

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(verifyScannerArchive(tampered, LINUX, signatures, publicKey)).rejects.toThrow(
      'SonarScanner archive signature verification failed.',
    );
  });

  it('rejects a signature made by another key', async () => {
    const other = await openpgp.generateKey({
      type: 'rsa',
      rsaBits: 2048,
      userIDs: [{ name: 'Other', email: 'other@example.com' }],
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(verifyScannerArchive(ARCHIVE, LINUX, signatures, other.publicKey)).rejects.toThrow(
      CommandFailedError,
    );
  });

  it('refuses a platform without a pinned signature', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      verifyScannerArchive(
        ARCHIVE,
        { os: 'macos', arch: 'arm64', extension: '' },
        signatures,
        publicKey,
      ),
    ).rejects.toThrow('No pinned signature available for SonarScanner on');
  });
});
