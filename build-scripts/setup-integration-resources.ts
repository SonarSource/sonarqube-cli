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
 * tests/integration/resources/dependency-artifacts/ using the original versioned
 * filenames (e.g. sonar-secrets-2.41.0.10709-linux-x86-64.exe). The fake binaries
 * server in the integration harness serves these files locally.
 *
 * Run via: bun build-scripts/setup-integration-resources.ts
 * Or via:  bun run test:integration:prepare
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';

import type { BinarySpec } from '../src/cli/commands/_common/install/binary.js';
import { SCA_SCANNER_SPEC } from '../src/cli/commands/_common/install/sca-scanner.js';
import { SECRETS_SPEC } from '../src/cli/commands/_common/install/secrets.js';
import { detectPlatform } from '../src/lib/platform-detector.js';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '../src/lib/signatures.js';
import {
  buildCagDownloadUrl,
  buildDownloadUrl,
  downloadBinary,
  verifyBinarySignature,
} from '../src/lib/sonarsource-releases.js';
import { DEPENDENCY_ARTIFACTS_DIR } from './dependency-artifacts-path.js';

const RESOURCES_DIR = join(import.meta.dir, '..', 'tests', 'integration', 'resources');
const platform = detectPlatform();

const FIXTURES: BinarySpec[] = [SECRETS_SPEC, SCA_SCANNER_SPEC];

mkdirSync(RESOURCES_DIR, { recursive: true });
mkdirSync(DEPENDENCY_ARTIFACTS_DIR, { recursive: true });

for (const fixture of FIXTURES) {
  await prepareBinaryFixture(fixture);
}

async function prepareBinaryFixture(fixture: BinarySpec): Promise<void> {
  const downloadUrl = buildDownloadUrl(fixture.name, fixture.version, fixture.distPrefix, platform);
  const signatureUrl = `${downloadUrl}.asc`;
  // Keep the original versioned filename so the fake binaries server can match requests exactly
  const downloadFilename = downloadUrl.split('/').at(-1)!;
  const destPath = join(DEPENDENCY_ARTIFACTS_DIR, downloadFilename);
  const ascDestPath = join(DEPENDENCY_ARTIFACTS_DIR, `${downloadFilename}.asc`);

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

// sonar-context-augmentation: best-effort download. Integration tests for the
// CAG flow use a stub binary written directly into the test cliHome via
// `withContextAugmentationBinaryInstalled()`; this download is only useful for
// exercising the real archive/signature path against the fake binaries server.
const cagArchiveUrl = buildCagDownloadUrl(SONAR_CONTEXT_AUGMENTATION_VERSION, platform);
const cagAscUrl = `${cagArchiveUrl}.asc`;
const cagArchiveFilename = cagArchiveUrl.split('/').at(-1)!;
const cagArchivePath = join(DEPENDENCY_ARTIFACTS_DIR, cagArchiveFilename);
const cagAscPath = `${cagArchivePath}.asc`;

if (!existsSync(cagArchivePath) || !existsSync(cagAscPath)) {
  console.log(
    `Downloading sonar-context-augmentation ${SONAR_CONTEXT_AUGMENTATION_VERSION} for ${platform.os}-${platform.arch}`,
  );
  console.log(`  from ${cagArchiveUrl}`);
  try {
    await downloadBinary(cagArchiveUrl, cagArchivePath);
    await downloadBinary(cagAscUrl, cagAscPath);
    console.log('  Download complete.');
  } catch (err) {
    console.log(
      `  Skipped (artifact not available): ${(err as Error).message}\n` +
        `  Integration tests will use a stub binary instead.`,
    );
  }
}

// CAG stub binary: compile a tiny TS fixture to a real native executable so
// Windows can spawn it as a PE. The harness copies this into each test's
// isolated <cliHome>/bin under the CAG-versioned filename; per-test exit codes
// and the sentinel path are passed via env vars (see tests/integration/resources/cag-stub.ts).
const cagStubSource = join(RESOURCES_DIR, 'cag-stub.ts');
const cagStubOutfile = join(RESOURCES_DIR, platform.os === 'windows' ? 'cag-stub.exe' : 'cag-stub');
if (!existsSync(cagStubOutfile)) {
  console.log(`Compiling CAG stub fixture for ${platform.os}-${platform.arch}`);
  // Use process.execPath so we invoke the same bun runtime that's running this
  // script, rather than resolving `bun` through PATH (also satisfies S4036).
  const result = spawnSync(
    process.execPath,
    ['build', '--compile', cagStubSource, '--outfile', cagStubOutfile],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to compile CAG stub: bun build exited with ${result.status}`);
  }
  console.log(`  CAG stub ready at ${cagStubOutfile}`);
}
