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

// Sonarsource binaries client for downloading sonar-secrets

import { readFileSync } from 'node:fs';
import type { PlatformInfo } from './install-types.js';
import logger from './logger.js';
import { version as VERSION } from '../../package.json';
import { SONARSOURCE_BINARIES_URL, SONAR_SECRETS_DIST_PREFIX } from './config-constants.js';

const DOWNLOAD_TIMEOUT_MS = 60000;

/**
 * Build the download filename — Sonarsource always uses .exe regardless of platform
 */
function buildDownloadFilename(version: string, platformInfo: PlatformInfo): string {
  return `sonar-secrets-${version}-${platformInfo.os}-${platformInfo.arch}.exe`;
}

/**
 * Build the full download URL for a specific version and platform
 */
export function buildDownloadUrl(version: string, platformInfo: PlatformInfo): string {
  const filename = buildDownloadFilename(version, platformInfo);
  return `${SONARSOURCE_BINARIES_URL}/${SONAR_SECRETS_DIST_PREFIX}/${filename}`;
}

/**
 * Download binary from URL to destination path.
 * The destination filename determines the local name — no .exe on Linux/macOS.
 */
export async function downloadBinary(url: string, destinationPath: string): Promise<void> {
  logger.debug(`Downloading binary from: ${url}`);

  const response = await fetch(url, {
    headers: { 'User-Agent': `sonarqube-cli/${VERSION}` },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  const fs = await import('node:fs/promises');
  await fs.writeFile(destinationPath, Buffer.from(buffer));
}

/**
 * Verify a binary buffer against a detached armored PGP signature and public key.
 * Throws if the signature is invalid or was not made by the given key.
 */
export async function verifyPgpSignature(
  binary: Buffer,
  armoredSignature: string,
  armoredPublicKey: string,
): Promise<void> {
  const { readKey, readSignature, createMessage, verify } = await import('openpgp');

  const verificationKey = await readKey({ armoredKey: armoredPublicKey });
  const signature = await readSignature({ armoredSignature });
  const message = await createMessage({ binary });

  const verificationResult = await verify({
    message,
    verificationKeys: [verificationKey],
    signature,
  });

  const sig = verificationResult.signatures[0];
  try {
    await sig.verified;
  } catch (e) {
    throw new Error(`Binary signature verification failed: ${(e as Error).message}`);
  }
}

/**
 * Verify the PGP signature of a downloaded binary.
 *
 * Looks up the per-platform .asc signature from the provided signatures map,
 * then verifies the binary against it using the provided public key.
 * Throws if the platform signature is missing or does not match the binary.
 */
export async function verifyBinarySignature(
  binaryPath: string,
  platformInfo: PlatformInfo,
  signatures: Record<string, string>,
  armoredPublicKey: string,
): Promise<void> {
  const platformKey = `${platformInfo.os}-${platformInfo.arch}`;
  const armoredSignature = signatures[platformKey];
  if (!armoredSignature) {
    throw new Error(`Signature not found for ${platformKey}. Run: npm run fetch:signatures`);
  }

  const binary = readFileSync(binaryPath);
  await verifyPgpSignature(binary, armoredSignature, armoredPublicKey);
}
