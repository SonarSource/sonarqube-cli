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
 * Download the pinned sonar-context-augmentation binary (if not already cached),
 * invoke `tool dump-cli-tree --pretty`, and return the parsed command tree.
 *
 * Used by the docs build to merge CAG's subcommand surface into commands.json / llms.txt.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chmod,readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFileFromTarGz } from '../../src/cli/commands/_common/install/tar.js';
import { buildCagPlatformSuffix } from '../../src/lib/install-types.js';
import { detectPlatform } from '../../src/lib/platform-detector.js';
import {
  SONAR_CONTEXT_AUGMENTATION_SIGNATURES,
  SONAR_CONTEXT_AUGMENTATION_VERSION,
  SONARSOURCE_PUBLIC_KEY,
} from '../../src/lib/signatures.js';
import {
  buildCagDownloadUrl,
  downloadBinary,
  verifyPgpSignature,
} from '../../src/lib/sonarsource-releases.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CAG_CACHE_DIR = join(ROOT, 'node_modules', '.cache', 'sonarqube-cli', 'cag-docs');

export interface CagOption {
  long: string;
  short?: string;
  value_name?: string;
  help?: string;
  required: boolean;
  default?: string;
  num_args?: string;
}

export interface CagCommand {
  name: string;
  about?: string;
  options?: CagOption[];
  subcommands?: CagCommand[];
}

export interface CagCliTree {
  version: string;
  subcommands: CagCommand[];
}

/**
 * Ensure the pinned CAG binary is cached locally and return its path.
 * Verifies the PGP signature on first download.
 * Throws on download failure, signature mismatch, or missing archive content.
 */
async function resolveCagBinary(): Promise<string> {
  const platform = detectPlatform();
  const platSuffix = buildCagPlatformSuffix(platform);
  const version = SONAR_CONTEXT_AUGMENTATION_VERSION;
  const cacheDir = join(CAG_CACHE_DIR, version);

  mkdirSync(cacheDir, { recursive: true });

  const binaryName = `sonar-context-augmentation-${version}-${platSuffix}${platform.extension}`;
  const binaryPath = join(cacheDir, binaryName);

  if (existsSync(binaryPath)) {
    return binaryPath;
  }

  const archiveUrl = buildCagDownloadUrl(version, platform);
  const archivePath = `${binaryPath}.tar.gz`;
  const ascPath = `${archivePath}.asc`;

  console.log(`  Downloading sonar-context-augmentation ${version} for ${platSuffix}…`);
  await downloadBinary(archiveUrl, archivePath);
  await downloadBinary(`${archiveUrl}.asc`, ascPath);

  const [archiveBytes, armoredSignature] = await Promise.all([
    readFile(archivePath),
    readFile(ascPath, 'utf-8'),
  ]);

  const expected = SONAR_CONTEXT_AUGMENTATION_SIGNATURES[platSuffix];
  if (!expected) {
    throw new Error(
      `No pinned signature for sonar-context-augmentation on ${platSuffix}. ` +
        `Run \`bun run fetch:signatures\` to refresh.`,
    );
  }
  if (expected !== armoredSignature.trim()) {
    throw new Error(
      `Signature mismatch for sonar-context-augmentation on ${platSuffix}: ` +
        `the downloaded .asc does not match the pinned signature.`,
    );
  }
  await verifyPgpSignature(archiveBytes, armoredSignature, SONARSOURCE_PUBLIC_KEY);

  const binaryBytes = extractFileFromTarGz(
    archiveBytes,
    `sonar-context-augmentation${platform.extension}`,
  );
  if (!binaryBytes) {
    throw new Error(
      `sonar-context-augmentation binary not found inside ${archiveUrl.split('/').at(-1)}.`,
    );
  }

  writeFileSync(binaryPath, binaryBytes);
  if (platform.os !== 'windows') {
    await chmod(binaryPath, 0o755);
  }

  return binaryPath;
}

/**
 * Download and run `sonar-context-augmentation tool dump-cli-tree --pretty`,
 * returning the parsed JSON command tree.
 *
 * Set `CAG_BINARY_PATH` to skip the download and use a pre-built binary instead
 * (useful for local development against an unreleased CAG build).
 *
 * Throws on download / verification failure or non-zero exit from the binary.
 */
export async function dumpCagTree(): Promise<CagCliTree> {
  const overridePath = process.env['CAG_BINARY_PATH'];
  let binaryPath: string;
  if (overridePath) {
    console.log(`Using CAG binary override: ${overridePath}`);
    binaryPath = overridePath;
  } else {
    console.log('Fetching sonar-context-augmentation CLI tree for docs generation…');
    binaryPath = await resolveCagBinary();
  }

  const result = spawnSync(binaryPath, ['tool', 'dump-cli-tree', '--pretty'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0 || result.error) {
    const detail = result.error?.message ?? result.stderr ?? '(no output)';
    throw new Error(
      `sonar-context-augmentation tool dump-cli-tree failed (exit ${result.status ?? 'null'}): ${detail}`,
    );
  }

  return JSON.parse(result.stdout) as CagCliTree;
}
