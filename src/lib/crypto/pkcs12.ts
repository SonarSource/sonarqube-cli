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

export function isPkcs12Path(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.p12') || lower.endsWith('.pfx');
}
