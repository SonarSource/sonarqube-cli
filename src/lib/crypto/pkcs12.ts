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

import forge from 'node-forge';

import { CryptographicError } from '../errors';

export interface Pkcs12Pem {
  cert: string;
  key: string;
}

export function pkcs12ToPem(p12Buffer: Buffer, password: string | undefined): Pkcs12Pem {
  const p12 = parseP12(p12Buffer, password);
  const { certBags, keyBag } = extractBags(p12);
  return serializeToPem(certBags, keyBag);
}

function parseP12(buffer: Buffer, password: string | undefined): forge.pkcs12.Pkcs12Pfx {
  try {
    const asn1 = forge.asn1.fromDer(buffer.toString('binary'));
    return forge.pkcs12.pkcs12FromAsn1(asn1, password ?? '');
  } catch (err) {
    throw new CryptographicError(
      err instanceof Error ? err.message : 'Failed to parse PKCS12 file',
      { cause: err },
    );
  }
}

function extractBags(p12: forge.pkcs12.Pkcs12Pfx): {
  certBags: forge.pkcs12.Bag[];
  keyBag: forge.pkcs12.Bag;
} {
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const shroudedKeyBags =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ] ?? [];
  const plainKeyBags = p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [];
  const keyBags = [...shroudedKeyBags, ...plainKeyBags];

  if (certBags.length === 0 || keyBags.length === 0) {
    throw new CryptographicError('PKCS12 file does not contain a certificate and private key');
  }
  if (keyBags.length > 1) {
    throw new CryptographicError(
      `PKCS12 file contains ${keyBags.length} private keys; provide a bundle with exactly one`,
    );
  }

  return { certBags, keyBag: keyBags[0] };
}

function serializeToPem(certBags: forge.pkcs12.Bag[], keyBag: forge.pkcs12.Bag): Pkcs12Pem {
  const cert = certBags
    .map((bag) => bag.cert)
    .filter((c) => c != null)
    .map((c) => forge.pki.certificateToPem(c))
    .join('');

  if (!cert) {
    throw new CryptographicError('PKCS12 file does not contain a valid certificate');
  }

  if (keyBag.key == null) {
    throw new CryptographicError('PKCS12 file does not contain a valid private key');
  }
  return { cert, key: forge.pki.privateKeyToPem(keyBag.key) };
}

function isEncryptedKeyPem(pem: string): boolean {
  return (
    pem.includes('BEGIN ENCRYPTED PRIVATE KEY') ||
    (pem.includes('BEGIN RSA PRIVATE KEY') && pem.includes('Proc-Type: 4,ENCRYPTED'))
  );
}

// Parses unencrypted, traditionally-encrypted RSA (PKCS#1), or encrypted PKCS#8 private key PEM.
function parsePrivateKeyPem(
  keyPem: string,
  passphrase: string | undefined,
): forge.pki.rsa.PrivateKey {
  if (!isEncryptedKeyPem(keyPem)) {
    return forge.pki.privateKeyFromPem(keyPem);
  }
  if (!passphrase) {
    throw new CryptographicError('Private key is encrypted: provide a passphrase to decrypt it');
  }
  const key = forge.pki.decryptRsaPrivateKey(keyPem, passphrase) as forge.pki.rsa.PrivateKey | null;
  if (!key) {
    throw new CryptographicError(
      'Failed to decrypt private key: check that the passphrase is correct',
    );
  }
  return key;
}

export function pemToPkcs12(certPem: string, keyPem: string, passphrase?: string): Buffer {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    const key = parsePrivateKeyPem(keyPem, passphrase);
    const p12Asn1 = forge.pkcs12.toPkcs12Asn1(key, [cert], '', {
      generateLocalKeyId: true,
    });
    return Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
  } catch (err) {
    throw new CryptographicError(
      err instanceof Error ? err.message : 'Failed to create PKCS12 from PEM files',
      { cause: err },
    );
  }
}

export function isPkcs12Path(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.p12') || lower.endsWith('.pfx');
}
