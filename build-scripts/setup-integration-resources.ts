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
 * Downloads the sonar-secrets and sca-scanner-cli binaries (plus PGP signatures)
 * for the current platform from binaries.sonarsource.com and places them in
 * tests/integration/resources/ using the original versioned filenames
 * (e.g. sonar-secrets-2.41.0.10709-linux-x86-64.exe). The fake binaries server
 * in the integration harness serves these files locally.
 *
 * Run via: bun build-scripts/setup-integration-resources.ts
 * Or via:  bun run test:integration:prepare
 */

import { existsSync, mkdirSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';

import type { BinarySpec } from '../src/cli/commands/_common/install/binary.js';
import { SCA_SCANNER_SPEC } from '../src/cli/commands/_common/install/sca-scanner.js';
import { SECRETS_SPEC } from '../src/cli/commands/_common/install/secrets.js';
import { detectPlatform } from '../src/lib/platform-detector.js';
import {
  buildDownloadUrl,
  downloadBinary,
  verifyBinarySignature,
} from '../src/lib/sonarsource-releases.js';

const RESOURCES_DIR = join(import.meta.dir, '..', 'tests', 'integration', 'resources');
const platform = detectPlatform();

const FIXTURES: BinarySpec[] = [SECRETS_SPEC, SCA_SCANNER_SPEC];

mkdirSync(RESOURCES_DIR, { recursive: true });

for (const fixture of FIXTURES) {
  await prepareBinaryFixture(fixture);
}

async function prepareBinaryFixture(fixture: BinarySpec): Promise<void> {
  const downloadUrl = buildDownloadUrl(fixture.name, fixture.version, fixture.distPrefix, platform);
  const signatureUrl = `${downloadUrl}.asc`;
  // Keep the original versioned filename so the fake binaries server can match requests exactly
  const downloadFilename = downloadUrl.split('/').at(-1)!;
  const destPath = join(RESOURCES_DIR, downloadFilename);
  const ascDestPath = join(RESOURCES_DIR, `${downloadFilename}.asc`);

  const binaryExists = existsSync(destPath);
  const ascExists = existsSync(ascDestPath);

  if (binaryExists && ascExists) {
    console.log(`${fixture.name} ${fixture.version} already present — skipping download.`);
    return;
  }

  if (!binaryExists) {
    console.log(
      `Downloading ${fixture.name} ${fixture.version} for ${platform.os}-${platform.arch}`,
    );
    console.log(`  from ${downloadUrl}`);
    await downloadBinary(downloadUrl, destPath);
    console.log('  Download complete.');

    console.log('Verifying PGP signature...');
    await verifyBinarySignature(destPath, platform, fixture.signatures, fixture.publicKey);
    console.log('  Signature verified.');

    if (platform.os !== 'windows') {
      await chmod(destPath, 0o755);
    }

    console.log(`${fixture.name} ready at ${destPath}`);
  }

  if (!ascExists) {
    console.log(`Downloading PGP signature file...`);
    console.log(`  from ${signatureUrl}`);
    await downloadBinary(signatureUrl, ascDestPath);
    console.log(`  Signature file ready at ${ascDestPath}`);
  }
}
