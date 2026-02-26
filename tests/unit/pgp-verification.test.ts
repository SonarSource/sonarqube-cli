/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Tests for verifyPgpSignature and verifyBinarySignature in a separate file so
// that Bun's module registry is not contaminated by secret-install.test.ts, which
// mocks sonarsource-releases.js for its own purposes.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as openpgp from 'openpgp';
import { verifyPgpSignature, verifyBinarySignature } from '../../src/lib/sonarsource-releases.js';
import type { PlatformInfo } from '../../src/lib/install-types.js';

const PLATFORM: PlatformInfo = { os: 'linux', arch: 'x86-64', extension: '' };

async function generateKeyPair() {
  return openpgp.generateKey({
    type: 'rsa',
    rsaBits: 2048,
    userIDs: [{ name: 'Test', email: 'test@example.com' }],
  });
}

async function sign(content: Buffer, armoredPrivateKey: string): Promise<string> {
  const privateKeyObj = await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey });
  const message = await openpgp.createMessage({ binary: content });
  return openpgp.sign({ message, signingKeys: privateKeyObj, detached: true }) as Promise<string>;
}

describe('verifyPgpSignature', () => {
  const binaryContent = Buffer.from('fake binary content for pgp tests');
  let armoredPublicKey: string;
  let armoredPrivateKey: string;

  beforeEach(async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    armoredPublicKey = publicKey;
    armoredPrivateKey = privateKey;
  });

  it('resolves when binary matches the signature and key', async () => {
    const armoredSignature = await sign(binaryContent, armoredPrivateKey);
    expect(
      verifyPgpSignature(binaryContent, armoredSignature, armoredPublicKey),
    ).resolves.toBeUndefined();
  });

  it('throws when the binary content does not match the signature', async () => {
    const armoredSignature = await sign(binaryContent, armoredPrivateKey);
    const tamperedContent = Buffer.from('tampered binary content');
    expect(verifyPgpSignature(tamperedContent, armoredSignature, armoredPublicKey)).rejects.toThrow(
      'Binary signature verification failed',
    );
  });

  it('throws when the signature was made by a different key', async () => {
    const { privateKey: otherPrivateKey } = await generateKeyPair();
    const signatureFromOtherKey = await sign(binaryContent, otherPrivateKey);
    expect(
      verifyPgpSignature(binaryContent, signatureFromOtherKey, armoredPublicKey),
    ).rejects.toThrow('Binary signature verification failed');
  });
});

describe('verifyBinarySignature', () => {
  const binaryContent = Buffer.from('fake binary content');
  let binaryPath: string;
  let armoredPublicKey: string;
  let armoredSignature: string;

  beforeEach(async () => {
    binaryPath = join(tmpdir(), `sonar-secrets-test-${Date.now()}`);
    writeFileSync(binaryPath, binaryContent);

    const { privateKey, publicKey } = await generateKeyPair();
    armoredPublicKey = publicKey;
    armoredSignature = await sign(binaryContent, privateKey);
  });

  afterEach(() => {
    rmSync(binaryPath, { force: true });
  });

  it('resolves when binary matches the signature and key', () => {
    const signatures = { 'linux-x86-64': armoredSignature };
    expect(
      verifyBinarySignature(binaryPath, PLATFORM, signatures, armoredPublicKey),
    ).resolves.toBeUndefined();
  });

  it('throws when no signature is registered for the platform', () => {
    const unknownPlatform: PlatformInfo = {
      os: 'linux',
      arch: 'arm' as PlatformInfo['arch'],
      extension: '',
    };
    expect(
      verifyBinarySignature(binaryPath, unknownPlatform, {}, armoredPublicKey),
    ).rejects.toThrow('Signature not found for linux-arm');
  });

  it('throws when the binary content does not match the signature', () => {
    writeFileSync(binaryPath, Buffer.from('tampered binary content'));
    const signatures = { 'linux-x86-64': armoredSignature };
    expect(
      verifyBinarySignature(binaryPath, PLATFORM, signatures, armoredPublicKey),
    ).rejects.toThrow('Binary signature verification failed');
  });
});
