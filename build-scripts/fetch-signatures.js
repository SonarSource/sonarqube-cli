#!/usr/bin/env node

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

  let totalFailures = 0;

  for (const [binaryName, { version, binaryPath, platforms }] of Object.entries(pkg.externalBinaries)) {
    console.log(`Fetching signatures for ${binaryName} ${version}\n`);

    const results = await Promise.allSettled(
      platforms.map(platform => fetchAndVerifySignature(platform, version, binaryPath, verificationKey))
    );

    let failures = 0;
    const signatures = {};
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error(`  ERROR: ${result.reason}`);
        failures++;
      } else if (result.value) {
        const { platform, armoredSignature } = result.value;
        signatures[platform] = armoredSignature;
      }
    }

    if (failures > 0) {
      console.error(`\n${failures} platform(s) failed for ${binaryName}.`);
      totalFailures += failures;
    } else {
      patchSignaturesTs(binaryName, version, signatures, SIGNATURES_TS_PATH);
    }

    console.log('');
  }

  if (totalFailures > 0) {
    process.exit(1);
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
  const binaryName = distPrefix.split('/').at(-1);
  const filename = `${binaryName}-${version}-${platform.os}-${platform.arch}.exe`;
  const ascUrl = `${SONARSOURCE_BINARIES_URL}/${distPrefix}/${filename}.asc`;

  process.stdout.write(`  ${platform.os}-${platform.arch} … `);

  const ascResponse = await fetch(ascUrl);
  if (!ascResponse.ok) {
    if (ascResponse.status === 404 || ascResponse.status === 403) {
      console.log(`Skipped: ${ascResponse.status}`);
      return null;
    }
    throw new Error(`${platform.os}-${platform.arch}: ASC download failed: ${ascResponse.status} ${ascResponse.statusText}`);
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
  const isTrusted = signatureKeyIDs.some(id => trustedKeyIDs.has(id));
  if (!isTrusted) {
    throw new Error(
      `${platform.os}-${platform.arch}: signature not issued by the trusted SonarSource key ` +
      `(got key IDs: ${signatureKeyIDs.join(', ')})`
    );
  }

  return { platform: `${platform.os}-${platform.arch}`, armoredSignature };
}

try {
  await fetchSignatures();
} catch (err) {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
}
