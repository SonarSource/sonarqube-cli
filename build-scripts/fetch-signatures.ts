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

/**
 * Build-time script: download and verify .asc signature files for all
 * external binaries at the pinned version, then embed them
 * into src/lib/signatures.ts so they compile into the binary.
 *
 * Run after bumping the version in package.json#externalBinaries:
 *   bun run fetch:signatures
 *
 * The .asc files are public on binaries.sonarsource.com. Each one is validated
 * to be a well-formed OpenPGP signature issued by the trusted SonarSource key
 * before being written to signatures.ts.
 *
 * Full binary+signature verification happens at runtime during `sonar install *`.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import * as openpgp from 'openpgp';

import { SONARSOURCE_BINARIES_URL } from '../src/lib/config-constants.ts';
import { SONARSOURCE_PUBLIC_KEY } from '../src/lib/signatures.ts';

interface Platform {
  os: string;
  arch: string;
}

type ArchiveFormat = 'tar.gz';
type PlatformNamingScheme = 'x64';

interface ExternalBinary {
  version: string;
  binaryPath: string;
  platforms: Platform[];
  /**
   * Optional archive format. When set, the artifact is `<binary>-<plat>-<ver>.<archive>`
   * inside `${binaryPath}-<plat>/`, signed via `<artifact>.asc`. Default
   * (undefined): single-file `<binary>-<ver>-<plat>.exe` directly under
   * `${binaryPath}/`, signed via `<artifact>.asc`.
   */
  archive?: ArchiveFormat;
  /**
   * Optional platform naming override. When set to `'x64'`, `x86-64` is rewritten
   * to `x64` in the URL (sonar-context-augmentation distribution convention).
   */
  platformNaming?: PlatformNamingScheme;
}

interface SignatureResult {
  platform: string;
  armoredSignature: string;
}

const SIGNATURES_TS_PATH = new URL('../src/lib/signatures.ts', import.meta.url);
const PACKAGE_JSON_PATH = new URL('../package.json', import.meta.url);

async function fetchSignatures(): Promise<void> {
  const verificationKey = await openpgp.readKey({ armoredKey: SONARSOURCE_PUBLIC_KEY });

  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as {
    externalBinaries: Record<string, ExternalBinary>;
  };
  for (const [binaryName, externalBinary] of Object.entries(pkg.externalBinaries)) {
    const { version, platforms } = externalBinary;
    console.log(`Fetching signatures for ${binaryName} v${version}\n`);

    const results = await Promise.all(
      platforms.map((platform) =>
        fetchAndVerifySignature(platform, externalBinary, verificationKey),
      ),
    );

    const signatures: Record<string, string> = {};
    for (const result of results) {
      if (result) {
        signatures[result.platform] = result.armoredSignature;
      }
    }

    patchSignaturesTs(binaryName, version, signatures, SIGNATURES_TS_PATH);
    console.log('');
  }
}

function patchSignaturesTs(
  binaryName: string,
  version: string,
  signatures: Record<string, string>,
  outputPath: URL,
): void {
  const PREFIX = binaryName.toUpperCase().replaceAll('-', '_');
  let content = readFileSync(outputPath, 'utf-8');

  content = content.replace(
    new RegExp(`^export const ${PREFIX}_VERSION = '.*';$`, 'm'),
    `export const ${PREFIX}_VERSION = '${version}';`,
  );

  const sigEntries = Object.entries(signatures)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, sig]) => `  '${platform}': \`${sig.trim()}\`,`);
  content = content.replace(
    new RegExp(String.raw`^export const ${PREFIX}_SIGNATURES[^=]+=\s*\{[^}]*\};$`, 'ms'),
    `export const ${PREFIX}_SIGNATURES: Record<string, string> = {\n${sigEntries.join('\n')}\n};`,
  );

  writeFileSync(outputPath, content, 'utf-8');
  console.log(`Patched ${outputPath.toString()}`);
}

function urlPlatformKey(platform: Platform, binary: ExternalBinary): string {
  const arch =
    binary.platformNaming === 'x64' && platform.arch === 'x86-64' ? 'x64' : platform.arch;
  return `${platform.os}-${arch}`;
}

function buildAscUrl(platform: Platform, binary: ExternalBinary): string {
  const platKey = urlPlatformKey(platform, binary);
  const binaryName = binary.binaryPath.split('/').at(-1);
  if (binary.archive === 'tar.gz') {
    // e.g. Distribution/sonar-context-augmentation-macos-arm64/sonar-context-augmentation-macos-arm64-0.9.0.355.tar.gz.asc
    return `${SONARSOURCE_BINARIES_URL}/${binary.binaryPath}-${platKey}/${binaryName}-${platKey}-${binary.version}.tar.gz.asc`;
  }
  // e.g. CommercialDistribution/sonar-secrets/sonar-secrets-2.41.0.10709-macos-arm64.exe.asc
  return `${SONARSOURCE_BINARIES_URL}/${binary.binaryPath}/${binaryName}-${binary.version}-${platKey}.exe.asc`;
}

/** Returns { platform, armoredSignature } if distributed, null if skipped. */
async function fetchAndVerifySignature(
  platform: Platform,
  binary: ExternalBinary,
  verificationKey: openpgp.Key,
): Promise<SignatureResult | null> {
  const displayPlatformKey = `${platform.os}-${platform.arch}`;
  // The map key must match the URL platform so runtime lookups in signatures.ts
  // resolve correctly when a binary maps `x86-64 → x64` (CAG).
  const mapPlatformKey = urlPlatformKey(platform, binary);
  const ascUrl = buildAscUrl(platform, binary);

  console.log(`  ${displayPlatformKey} … `);

  const ascResponse = await fetch(ascUrl);
  if (!ascResponse.ok) {
    if (ascResponse.status === 404 || ascResponse.status === 403) {
      console.log(`Skipped: ${ascResponse.status}`);
      return null;
    }
    throw new Error(
      `${displayPlatformKey}: ASC download failed: ${ascResponse.status} ${ascResponse.statusText}`,
    );
  }
  const armoredSignature = await ascResponse.text();

  // Validate the .asc is a well-formed OpenPGP signature issued by the trusted key.
  // Full binary verification happens at runtime during `sonar install *`.
  const signature = await openpgp.readSignature({ armoredSignature });
  const trustedKeyIDs = new Set([
    verificationKey.getKeyID().toHex(),
    ...verificationKey.getSubkeys().map((sub) => sub.getKeyID().toHex()),
  ]);
  const signatureKeyIDs = signature.packets.map((p) => p.issuerKeyID.toHex());
  if (!signatureKeyIDs.some((id) => trustedKeyIDs.has(id))) {
    throw new Error(
      `${displayPlatformKey}: signature not issued by the trusted SonarSource key ` +
        `(got key IDs: ${signatureKeyIDs.join(', ')})`,
    );
  }

  return { platform: mapPlatformKey, armoredSignature };
}

try {
  await fetchSignatures();
} catch (err) {
  console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
