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

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InvalidArgumentError } from 'commander';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { CLI_DIST_PREFIX, SONARSOURCE_BINARIES_URL } from '@/core/config-constants.ts';
import { detectPlatform, isWindows } from '@/core/host/environment/platform-detector.ts';
import { downloadBinary } from '@/core/host/install/sonarsource-releases.ts';
import { fetchText } from '@/core/update/check.ts';

const VERSION_PATTERN = /^\d[\d.]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function parseVersionOption(value: string): string {
  if (!VERSION_PATTERN.test(value)) {
    throw new InvalidArgumentError('Expected a version such as 1.2.3.');
  }
  return value;
}

export function parseArtifactBaseUrlOption(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError('Not a valid URL.');
  }
  const isSecure = url.protocol === 'https:';
  const isLocalHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (!isSecure && !isLocalHttp) {
    throw new InvalidArgumentError('Must be an https:// URL.');
  }
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function defaultArtifactBaseUrl(): string {
  return `${SONARSOURCE_BINARIES_URL}/${CLI_DIST_PREFIX}`;
}

export async function resolveTargetVersion(
  artifactBaseUrl: string,
  approvedVersion: string | undefined,
): Promise<string> {
  if (approvedVersion) {
    return approvedVersion;
  }
  const published = (await fetchText(`${artifactBaseUrl}/stable.version`, 'stable version')).trim();
  return parseVersionOption(published);
}

function artifactUrls(artifactBaseUrl: string, version: string): string[] {
  const { os, arch } = detectPlatform();
  const stem = `${artifactBaseUrl}/${version}/${os}/sonarqube-cli-${version}-${os}-${arch}`;
  return isWindows() ? [`${stem}.exe`] : [`${stem}.bin`, `${stem}.exe`];
}

async function downloadFirstAvailable(urls: string[], destination: string): Promise<string> {
  const failures: string[] = [];
  for (const url of urls) {
    try {
      await downloadBinary(url, destination);
      return url;
    } catch (error) {
      failures.push(`${url}: ${(error as Error).message}`);
    }
  }
  throw new CommandFailedError(`Could not download the SonarQube CLI.\n${failures.join('\n')}`, {
    remediationHint: 'Check the version and the CDN URL, then retry.',
  });
}

export interface VerifiedDownloadOptions {
  allowMissingChecksum: boolean;
  warn: (message: string) => void;
}

async function fetchExpectedSha256(checksumUrl: string): Promise<string> {
  const expected = (await fetchText(checksumUrl, 'checksum')).trim().split(/\s+/)[0]?.toLowerCase();
  if (!expected || !SHA256_PATTERN.test(expected)) {
    throw new CommandFailedError(`Could not read a SHA256 checksum from ${checksumUrl}.`);
  }
  return expected;
}

async function verifySha256(
  binaryPath: string,
  artifactUrl: string,
  { allowMissingChecksum, warn }: VerifiedDownloadOptions,
): Promise<void> {
  const checksumUrl = `${artifactUrl}.sha256`;
  let expected: string;
  try {
    expected = await fetchExpectedSha256(checksumUrl);
  } catch (error) {
    if (!allowMissingChecksum) {
      throw error;
    }
    warn(`${(error as Error).message} Skipping the integrity check.`);
    return;
  }
  const actual = createHash('sha256').update(readFileSync(binaryPath)).digest('hex');
  if (actual !== expected) {
    throw new CommandFailedError(
      `SHA256 mismatch for the downloaded binary.\n  expected: ${expected}\n  actual:   ${actual}`,
    );
  }
}

export async function withVerifiedBinary<T>(
  artifactBaseUrl: string,
  version: string,
  options: VerifiedDownloadOptions,
  use: (binaryPath: string) => Promise<T>,
): Promise<T> {
  const workDir = mkdtempSync(join(tmpdir(), 'sonar-mdm-'));
  try {
    const binaryPath = join(workDir, isWindows() ? 'sonar.exe' : 'sonar');
    const url = await downloadFirstAvailable(artifactUrls(artifactBaseUrl, version), binaryPath);
    await verifySha256(binaryPath, url, options);
    return await use(binaryPath);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
