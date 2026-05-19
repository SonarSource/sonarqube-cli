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

// Shared installation filesystem helpers used by multiple binary installers
// (sonar-secrets, sonar-context-augmentation). Lives separately so installers
// with different download/verify pipelines can still share cleanup and version
// probing.

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { BIN_DIR } from '../../../../lib/config-constants';
import logger from '../../../../lib/logger';
import { spawnProcess } from '../../../../lib/process';
import { CommandFailedError } from '../error';

const VERSION_REGEX_MAX_SEGMENT = 20;

/**
 * Verify the installation by probing the binary; throws with captured stdout/stderr
 * when the binary does not respond to `--version` or exits non-zero.
 */
export async function verifyInstallation(path: string): Promise<string> {
  let result: Awaited<ReturnType<typeof spawnProcess>>;
  try {
    result = await spawnProcess(path, ['--version'], { stdout: 'pipe', stderr: 'pipe' });
  } catch (err) {
    throw new CommandFailedError(
      `Installation verification failed: could not spawn ${path} --version: ${(err as Error).message}`,
    );
  }

  if (result.exitCode !== 0) {
    throw new CommandFailedError(
      `Installation verification failed: ${path} --version exited ${result.exitCode}.\n` +
        formatSpawnOutput(result.stdout, result.stderr),
    );
  }

  const pattern = String.raw`(\d{1,${VERSION_REGEX_MAX_SEGMENT}}(?:\.\d{1,${VERSION_REGEX_MAX_SEGMENT}}){2,3})`;
  const match = new RegExp(pattern).exec(result.stdout);
  if (!match) {
    throw new CommandFailedError(
      `Installation verification failed: could not parse version from --version output.\n` +
        formatSpawnOutput(result.stdout, result.stderr),
    );
  }
  return match[1];
}

function formatSpawnOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.trim()) parts.push(`stdout:\n${stdout.trimEnd()}`);
  if (stderr.trim()) parts.push(`stderr:\n${stderr.trimEnd()}`);
  return parts.length ? parts.join('\n') : '(no output)';
}

/**
 * Remove older versioned binaries left in `binDir` so the cache only keeps the
 * current version. Matches files starting with `<binaryName>-` excluding
 * `currentLocalName`.
 */
export function cleanupOldVersionBinaries(
  binDir: string,
  binaryName: string,
  currentLocalName: string,
): void {
  try {
    const oldFiles = readdirSync(binDir).filter(
      (f) => f.startsWith(`${binaryName}-`) && f !== currentLocalName,
    );
    for (const file of oldFiles) {
      rmSync(join(binDir, file), { force: true });
      logger.debug(`Removed old ${binaryName} binary: ${file}`);
    }
  } catch (err) {
    logger.debug(`Failed to clean up old ${binaryName} binaries: ${(err as Error).message}`);
  }
}

const FILE_EXECUTABLE_PERMS = 0o755; // rwxr-xr-x

export async function makeExecutable(path: string): Promise<void> {
  const { chmod } = await import('node:fs/promises');
  await chmod(path, FILE_EXECUTABLE_PERMS);
}

export function ensureBinDirectory(dir?: string): string {
  const binDir = dir ?? BIN_DIR;
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }
  return binDir;
}
