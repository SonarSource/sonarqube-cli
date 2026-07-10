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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';
import forge from 'node-forge';

import { isPkcs12Path, pemToPkcs12, pkcs12ToPem } from '../../../../src/lib/crypto/pkcs12';
import { CryptographicError } from '../../../../src/lib/errors';

const FIXTURE_DIR = join(import.meta.dir, '../../../fixtures/client-cert');
const P12_PATH = join(FIXTURE_DIR, 'client-cert.p12');
const P12_UNENCRYPTED_KEY_PATH = join(FIXTURE_DIR, 'client-cert-unencrypted-key.p12');
const CERT_PEM_PATH = join(FIXTURE_DIR, 'client-cert.pem');
const KEY_PEM_PATH = join(FIXTURE_DIR, 'client-key.pem');
const ENCRYPTED_KEY_PEM_PATH = join(FIXTURE_DIR, 'client-key-encrypted.pem');
const ENCRYPTED_KEY_PKCS8_PEM_PATH = join(FIXTURE_DIR, 'client-key-encrypted-pkcs8.pem');

describe('isPkcs12Path', () => {
  it('returns true for .p12', () => {
    expect(isPkcs12Path('/path/to/cert.p12')).toBe(true);
  });

  it('returns true for .pfx', () => {
    expect(isPkcs12Path('/path/to/cert.pfx')).toBe(true);
  });

  it('returns true for uppercase extension', () => {
    expect(isPkcs12Path('/path/to/cert.P12')).toBe(true);
  });

  it('returns false for .pem', () => {
    expect(isPkcs12Path('/path/to/cert.pem')).toBe(false);
  });

  it('returns false for .crt', () => {
    expect(isPkcs12Path('/path/to/cert.crt')).toBe(false);
  });

  it('returns false for .key', () => {
    expect(isPkcs12Path('/path/to/key.key')).toBe(false);
  });
});

// forge outputs CRLF; fixtures use LF
const normalizePem = (pem: string) => pem.replace(/\r\n/g, '\n');
// fixture is PKCS#8; forge outputs PKCS#1 RSA
const normalizeKey = (pem: string) => forge.pki.privateKeyToPem(forge.pki.privateKeyFromPem(pem));

describe('pkcs12ToPem', () => {
  it('extracts cert and key matching the fixture files', () => {
    const p12 = readFileSync(P12_PATH);
    const { cert, key } = pkcs12ToPem(p12, 'testpassword');

    expect(normalizePem(cert)).toBe(readFileSync(CERT_PEM_PATH, 'utf-8'));
    expect(normalizePem(key)).toBe(normalizePem(normalizeKey(readFileSync(KEY_PEM_PATH, 'utf-8'))));
  });

  it('throws CryptographicError on wrong password', () => {
    const p12 = readFileSync(P12_PATH);
    expect(() => pkcs12ToPem(p12, 'wrongpassword')).toThrow(CryptographicError);
  });

  it('throws CryptographicError on corrupted buffer', () => {
    const garbage = Buffer.from('not a pkcs12 file');
    expect(() => pkcs12ToPem(garbage, 'testpassword')).toThrow();
  });

  it('extracts cert and key from PKCS12 with an unencrypted (plain) private key', () => {
    const p12 = readFileSync(P12_UNENCRYPTED_KEY_PATH);
    const { cert, key } = pkcs12ToPem(p12, undefined);

    expect(normalizePem(cert)).toBe(readFileSync(CERT_PEM_PATH, 'utf-8'));
    expect(normalizePem(key)).toBe(normalizePem(normalizeKey(readFileSync(KEY_PEM_PATH, 'utf-8'))));
  });
});

describe('pemToPkcs12', () => {
  it('produces a parseable PKCS12 buffer from fixture PEM files (round-trip)', () => {
    const certPem = readFileSync(CERT_PEM_PATH, 'utf-8');
    const keyPem = readFileSync(KEY_PEM_PATH, 'utf-8');

    const p12Buffer = pemToPkcs12(certPem, keyPem);
    const { cert, key } = pkcs12ToPem(p12Buffer, undefined);

    expect(normalizePem(cert)).toBe(certPem);
    expect(normalizePem(key)).toBe(normalizePem(normalizeKey(keyPem)));
  });

  it('decrypts an encrypted private key when passphrase is provided (round-trip)', () => {
    const certPem = readFileSync(CERT_PEM_PATH, 'utf-8');
    const encryptedKeyPem = readFileSync(ENCRYPTED_KEY_PEM_PATH, 'utf-8');

    const p12Buffer = pemToPkcs12(certPem, encryptedKeyPem, 'testpassword');
    const { cert, key } = pkcs12ToPem(p12Buffer, undefined);

    expect(normalizePem(cert)).toBe(certPem);
    expect(normalizePem(key)).toBe(normalizePem(normalizeKey(readFileSync(KEY_PEM_PATH, 'utf-8'))));
  });

  it('decrypts a PKCS#8 encrypted private key when passphrase is provided (round-trip)', () => {
    const certPem = readFileSync(CERT_PEM_PATH, 'utf-8');
    const encryptedKeyPem = readFileSync(ENCRYPTED_KEY_PKCS8_PEM_PATH, 'utf-8');

    const p12Buffer = pemToPkcs12(certPem, encryptedKeyPem, 'testpassword');
    const { cert, key } = pkcs12ToPem(p12Buffer, undefined);

    expect(normalizePem(cert)).toBe(certPem);
    expect(normalizePem(key)).toBe(normalizePem(normalizeKey(readFileSync(KEY_PEM_PATH, 'utf-8'))));
  });

  it('throws CryptographicError when key is encrypted but no passphrase is given', () => {
    const certPem = readFileSync(CERT_PEM_PATH, 'utf-8');
    const encryptedKeyPem = readFileSync(ENCRYPTED_KEY_PEM_PATH, 'utf-8');

    expect(() => pemToPkcs12(certPem, encryptedKeyPem)).toThrow(CryptographicError);
  });

  it('throws CryptographicError when key is encrypted and wrong passphrase is given', () => {
    const certPem = readFileSync(CERT_PEM_PATH, 'utf-8');
    const encryptedKeyPem = readFileSync(ENCRYPTED_KEY_PEM_PATH, 'utf-8');

    expect(() => pemToPkcs12(certPem, encryptedKeyPem, 'wrongpassword')).toThrow(
      CryptographicError,
    );
  });

  it('throws CryptographicError on invalid cert PEM', () => {
    const keyPem = readFileSync(KEY_PEM_PATH, 'utf-8');
    expect(() => pemToPkcs12('not a cert', keyPem)).toThrow(CryptographicError);
  });

  it('throws CryptographicError on invalid key PEM', () => {
    const certPem = readFileSync(CERT_PEM_PATH, 'utf-8');
    expect(() => pemToPkcs12(certPem, 'not a key')).toThrow(CryptographicError);
  });

  it('throws CryptographicError when cert and key arguments are swapped', () => {
    const certPem = readFileSync(CERT_PEM_PATH, 'utf-8');
    const keyPem = readFileSync(KEY_PEM_PATH, 'utf-8');
    expect(() => pemToPkcs12(keyPem, certPem)).toThrow(CryptographicError);
  });

  it('generates output that cannot be parsed with a non-empty passphrase', () => {
    const certPem = readFileSync(CERT_PEM_PATH, 'utf-8');
    const keyPem = readFileSync(KEY_PEM_PATH, 'utf-8');
    const p12Buffer = pemToPkcs12(certPem, keyPem);
    expect(() => pkcs12ToPem(p12Buffer, 'wrongpassword')).toThrow(CryptographicError);
  });
});
