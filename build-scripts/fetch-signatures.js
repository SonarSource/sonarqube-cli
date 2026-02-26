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

/**
 * Build-time script: download and verify .asc signature files for all
 * external binaries at the pinned version, then embed them
 * into src/lib/signatures.ts so they compile into the binary.
 *
 * Run after bumping the version in package.json#externalBinaries:
 *   npm run fetch:signatures
 *
 * The .asc files are public on binaries.sonarsource.com. Each one is validated
 * to be a well-formed OpenPGP signature issued by the trusted SonarSource key
 * before being written to signatures.ts.
 *
 * Full binary+signature verification happens at runtime during `sonar install *`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import * as openpgp from 'openpgp';
import { SONARSOURCE_BINARIES_URL } from '../src/lib/config-constants.js';
import { SONARSOURCE_PUBLIC_KEY } from '../src/lib/signatures.js';
import pkg from '../package.json' with { type: 'json' };

const SIGNATURES_TS_PATH = new URL('../src/lib/signatures.ts', import.meta.url);

async function fetchSignatures() {
  const verificationKey = await openpgp.readKey({ armoredKey: SONARSOURCE_PUBLIC_KEY });

  for (const [binaryName, { version, binaryPath, platforms }] of Object.entries(pkg.externalBinaries)) {
    console.log(`Fetching signatures for ${binaryName} v${version}\n`);

    const results = await Promise.all(
      platforms.map(platform => fetchAndVerifySignature(platform, version, binaryPath, verificationKey))
    );

    const signatures = {};
    for (const result of results) {
      if (result) {
        signatures[result.platform] = result.armoredSignature;
      }
    }

    patchSignaturesTs(binaryName, version, signatures, SIGNATURES_TS_PATH);
    console.log('');
  }
}

function patchSignaturesTs(binaryName, version, signatures, outputPath) {
  const PREFIX = binaryName.toUpperCase().replaceAll('-', '_');
  let content = readFileSync(outputPath, 'utf-8');

  content = content.replace(
    new RegExp(`^export const ${PREFIX}_VERSION = '.*';$`, 'm'),
    `export const ${PREFIX}_VERSION = '${version}';`
  );

  const sigEntries = Object.entries(signatures)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, sig]) => `  '${platform}': \`${sig.trim()}\`,`);
  content = content.replace(
    new RegExp(String.raw`^export const ${PREFIX}_SIGNATURES[^=]+=\s*\{[^}]*\};$`, 'ms'),
    `export const ${PREFIX}_SIGNATURES: Record<string, string> = {\n${sigEntries.join('\n')}\n};`
  );

  writeFileSync(outputPath, content, 'utf-8');
  console.log(`Patched ${outputPath}`);
}

/** Returns { platform, armoredSignature } if distributed, null if skipped. */
async function fetchAndVerifySignature(platform, version, distPrefix, verificationKey) {
  const platformKey = `${platform.os}-${platform.arch}`;
  const binaryName = distPrefix.split('/').at(-1);
  const ascUrl = `${SONARSOURCE_BINARIES_URL}/${distPrefix}/${binaryName}-${version}-${platformKey}.exe.asc`;

  console.log(`  ${platformKey} … `);

  const ascResponse = await fetch(ascUrl);
  if (!ascResponse.ok) {
    if (ascResponse.status === 404 || ascResponse.status === 403) {
      console.log(`Skipped: ${ascResponse.status}`);
      return null;
    }
    throw new Error(`${platformKey}: ASC download failed: ${ascResponse.status} ${ascResponse.statusText}`);
  }
  const armoredSignature = await ascResponse.text();

  // Validate the .asc is a well-formed OpenPGP signature issued by the trusted key.
  // Full binary verification happens at runtime during `sonar install *`.
  const signature = await openpgp.readSignature({ armoredSignature });
  const trustedKeyIDs = new Set([
    verificationKey.getKeyID().toHex(),
    ...verificationKey.getSubkeys().map(sub => sub.getKeyID().toHex()),
  ]);
  const signatureKeyIDs = signature.packets.map(p => p.issuerKeyID.toHex());
  if (!signatureKeyIDs.some(id => trustedKeyIDs.has(id))) {
    throw new Error(
      `${platformKey}: signature not issued by the trusted SonarSource key ` +
      `(got key IDs: ${signatureKeyIDs.join(', ')})`
    );
  }

  return { platform: platformKey, armoredSignature };
}

try {
  await fetchSignatures();
} catch (err) {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
}
