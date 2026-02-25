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

import type { PlatformInfo } from './install-types.js';
import logger from './logger.js';
import { version as VERSION } from '../../package.json';
import { SONARSOURCE_BINARIES_URL, SONAR_SECRETS_DIST_PREFIX } from './config-constants.js';

const REQUEST_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 60000;

/**
 * Parse S3 XML listing and extract all <Key> values
 */
function parseXmlKeys(xml: string): string[] {
  const matches = [...xml.matchAll(/<Key[^>]*>([^<]+)<\/Key>/g)];
  return matches.map(m => m[1]);
}

/**
 * Extract version from sonar-secrets filename key
 * e.g. "CommercialDistribution/sonar-secrets/sonar-secrets-1.0.0-linux-x86-64.exe" → "1.0.0"
 */
function extractVersion(key: string): string | null {
  const filename = key.split('/').pop() ?? '';
  const match = /^sonar-secrets-(\d+\.\d+(?:\.\d+)*)-/.exec(filename);
  return match ? match[1] : null;
}

/**
 * Compare two dot-separated version strings numerically
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Fetch latest available version from the Sonarsource binaries S3 listing
 */
export async function fetchLatestVersion(): Promise<string> {
  const url = `${SONARSOURCE_BINARIES_URL}/s3api?prefix=${SONAR_SECRETS_DIST_PREFIX}/&delimiter=/`;

  const response = await fetch(url, {
    headers: { 'User-Agent': `sonarqube-cli/${VERSION}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch version listing: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();

  if (xml.includes('<IsTruncated>true</IsTruncated>')) {
    logger.warn('Binary listing is truncated — version discovery may be incomplete');
  }

  const keys = parseXmlKeys(xml);
  const versions = [...new Set(
    keys.map(extractVersion).filter((v): v is string => v !== null)
  )];

  if (versions.length === 0) {
    throw new Error('No versions found in Sonarsource binaries listing');
  }

  versions.sort(compareVersions);
  return versions.at(-1)!;
}

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
