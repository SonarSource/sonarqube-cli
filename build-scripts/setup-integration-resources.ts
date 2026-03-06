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
 * Downloads the sonar-secrets binary for the current platform from
 * binaries.sonarsource.com and places it in tests/integration/resources/.
 *
 * Run via: bun build-scripts/setup-integration-resources.ts
 * Or via:  bun run test:integration:prepare
 */

import { existsSync, mkdirSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { detectPlatform, buildLocalBinaryName } from '../src/lib/platform-detector.js';
import {
  buildDownloadUrl,
  downloadBinary,
  verifyBinarySignature,
} from '../src/lib/sonarsource-releases.js';
import {
  SONAR_SECRETS_VERSION,
  SONAR_SECRETS_SIGNATURES,
  SONARSOURCE_PUBLIC_KEY,
} from '../src/lib/signatures.js';

const RESOURCES_DIR = join(import.meta.dir, '..', 'tests', 'integration', 'resources');
const platform = detectPlatform();
const binaryName = buildLocalBinaryName(platform);
const destPath = join(RESOURCES_DIR, binaryName);

if (existsSync(destPath)) {
  console.log(`sonar-secrets already present at ${destPath} — skipping download.`);
  process.exit(0);
}

mkdirSync(RESOURCES_DIR, { recursive: true });

const downloadUrl = buildDownloadUrl(SONAR_SECRETS_VERSION, platform);
console.log(
  `Downloading sonar-secrets ${SONAR_SECRETS_VERSION} for ${platform.os}-${platform.arch}`,
);
console.log(`  from ${downloadUrl}`);

await downloadBinary(downloadUrl, destPath);
console.log('  Download complete.');

console.log('Verifying PGP signature...');
await verifyBinarySignature(destPath, platform, SONAR_SECRETS_SIGNATURES, SONARSOURCE_PUBLIC_KEY);
console.log('  Signature verified.');

if (platform.os !== 'windows') {
  await chmod(destPath, 0o755);
}

console.log(`sonar-secrets ready at ${destPath}`);
