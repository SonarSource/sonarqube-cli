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

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { isWindows } from '@/core/host/environment/platform-detector.ts';
import { verifyInstallation } from '@/core/host/install/install-utils.ts';
import { EXECUTABLE_MODE, removeBinary, replaceBinary } from '@/core/host/self-replace.ts';
import { spawnProcess } from '@/core/process/process.ts';
import { stripBuildNumber } from '@/core/version.ts';

import {
  defaultArtifactBaseUrl,
  resolveTargetVersion,
  withVerifiedBinary,
} from './mdm-artifact.ts';
import {
  defaultMdmEnvironment,
  type MdmEnvironment,
  standaloneBinaryPath,
} from './mdm-environment.ts';
import {
  addToMachinePath,
  grantReadExecuteToAllUsers,
  removeFromMachinePath,
} from './windows-machine.ts';

export interface MdmInstallOptions {
  skipIfPresent?: boolean;
  skipStandaloneLinks?: boolean;
}

export interface MdmUpdateOptions {
  approvedVersion?: string;
  force?: boolean;
  artifactBaseUrl?: string;
  allowMissingChecksum?: boolean;
}

export interface MdmRollbackOptions {
  version: string;
  artifactBaseUrl?: string;
  allowMissingChecksum?: boolean;
}

export interface MdmRemoveOptions {
  mdmBinaryOnly?: boolean;
}

const SEMVER_PREFIX = /^\d+\.\d+\.\d+/;
const MACOS_QUARANTINE_ATTRIBUTE = 'com.apple.quarantine';

async function readVersionOutput(binaryPath: string): Promise<string | null> {
  try {
    const { stdout } = await spawnProcess(binaryPath, ['--version']);
    return SEMVER_PREFIX.exec(stdout.trim())?.[0] ?? null;
  } catch {
    return null;
  }
}

async function placeBinary(
  sourcePath: string,
  targetPath: string,
  env: MdmEnvironment,
): Promise<void> {
  await replaceBinary(sourcePath, targetPath);
  if (isWindows()) {
    if (env.skipMachineIntegration) {
      return;
    }
    await grantReadExecuteToAllUsers(targetPath);
  } else if (process.platform === 'darwin') {
    await spawnProcess('xattr', ['-d', MACOS_QUARANTINE_ATTRIBUTE, targetPath]);
  }
}

function isSameFile(first: string, second: string): boolean {
  return existsSync(first) && existsSync(second) && realpathSync(first) === realpathSync(second);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function pathExistsOrLinked(path: string): boolean {
  return existsSync(path) || isLink(path);
}

async function linkStandaloneInstalls(
  env: MdmEnvironment,
  { console }: CommandInvocationContext,
): Promise<void> {
  for (const home of await env.listUserHomes()) {
    const standalone = standaloneBinaryPath(home);
    if (!pathExistsOrLinked(standalone)) {
      continue;
    }
    if (isLink(standalone) && readlinkSync(standalone) === env.binaryPath) {
      console.text(`  ${standalone} — already symlinked, skipping`);
      continue;
    }
    console.text(`  ${standalone} — replacing with symlink to ${env.binaryPath}`);
    await removeBinary(standalone);
    mkdirSync(dirname(standalone), { recursive: true });
    symlinkSync(env.binaryPath, standalone);
  }
}

async function removeStandaloneInstalls(
  env: MdmEnvironment,
  { console }: CommandInvocationContext,
): Promise<void> {
  for (const home of await env.listUserHomes()) {
    const standalone = standaloneBinaryPath(home);
    if (pathExistsOrLinked(standalone)) {
      console.text(`  ${standalone} — removing...`);
      await removeBinary(standalone);
    }
  }
}

function resolveOnPath(command: string): string | null {
  const extensions = isWindows() ? (process.env.PATHEXT ?? '.EXE').split(';') : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function removeRemainingBinariesOnPath({ console }: CommandInvocationContext): Promise<void> {
  for (let found = resolveOnPath('sonar'); found !== null; found = resolveOnPath('sonar')) {
    if ((await readVersionOutput(found)) === null) {
      throw new CommandFailedError(
        `${found} does not look like the SonarQube CLI (unexpected --version output) — refusing to remove it.`,
      );
    }
    console.text(`sonar still resolves to: ${found} — removing...`);
    await removeBinary(found);
    if (pathExistsOrLinked(found)) {
      throw new CommandFailedError(`Failed to remove ${found}.`);
    }
  }
}

function restoreExecutableMode(binaryPath: string): void {
  if (!isWindows()) {
    chmodSync(binaryPath, EXECUTABLE_MODE);
  }
}

async function downloadAndPlace(
  env: MdmEnvironment,
  artifactBaseUrl: string,
  version: string,
  { console }: CommandInvocationContext,
  allowMissingChecksum: boolean | undefined,
): Promise<void> {
  const downloadOptions = {
    allowMissingChecksum: allowMissingChecksum ?? false,
    warn: (message: string) => {
      console.warn(message);
    },
  };
  await withVerifiedBinary(artifactBaseUrl, version, downloadOptions, async (downloaded) => {
    restoreExecutableMode(downloaded);
    await verifyInstallation(downloaded);
    await placeBinary(downloaded, env.binaryPath, env);
  });
  await verifyInstallation(env.binaryPath);
}

export async function mdmInstall(
  options: MdmInstallOptions,
  ctx: CommandInvocationContext,
  env: MdmEnvironment = defaultMdmEnvironment(),
): Promise<void> {
  const { console } = ctx;
  if (options.skipIfPresent && existsSync(env.binaryPath)) {
    restoreExecutableMode(env.binaryPath);
    console.text(`SonarQube CLI already present at ${env.binaryPath} — skipping.`);
    return;
  }
  console.info(`Installing SonarQube CLI to ${env.binaryPath}...`);

  if (!isSameFile(process.execPath, env.binaryPath)) {
    await placeBinary(process.execPath, env.binaryPath, env);
  }
  if (isWindows() && !env.skipMachineIntegration) {
    await addToMachinePath(dirname(env.binaryPath));
  }
  if (!options.skipStandaloneLinks && !isWindows()) {
    await linkStandaloneInstalls(env, ctx);
  }
  await verifyInstallation(env.binaryPath);

  const version = await readVersionOutput(env.binaryPath);
  console.success(`SonarQube CLI ${version ?? ''} installed at ${env.binaryPath}`);
}

export async function mdmUpdate(
  options: MdmUpdateOptions,
  ctx: CommandInvocationContext,
  env: MdmEnvironment = defaultMdmEnvironment(),
): Promise<void> {
  const { console } = ctx;
  const artifactBaseUrl = options.artifactBaseUrl ?? defaultArtifactBaseUrl();
  const target = await resolveTargetVersion(artifactBaseUrl, options.approvedVersion);
  console.info(`Target version: ${target}`);

  const isPresent = existsSync(env.binaryPath);
  if (isPresent) {
    restoreExecutableMode(env.binaryPath);
  }
  const installed = isPresent ? await readVersionOutput(env.binaryPath) : null;
  if (installed !== null && !options.force && installed === stripBuildNumber(target)) {
    console.success(`Already at version ${target}, nothing to do.`);
    return;
  }

  await downloadAndPlace(env, artifactBaseUrl, target, ctx, options.allowMissingChecksum);
  console.success(`SonarQube CLI ${target} installed at ${env.binaryPath}`);
}

export async function mdmRollback(
  options: MdmRollbackOptions,
  ctx: CommandInvocationContext,
  env: MdmEnvironment = defaultMdmEnvironment(),
): Promise<void> {
  const artifactBaseUrl = options.artifactBaseUrl ?? defaultArtifactBaseUrl();
  await downloadAndPlace(env, artifactBaseUrl, options.version, ctx, options.allowMissingChecksum);
  ctx.console.success(`SonarQube CLI rolled back to ${options.version} at ${env.binaryPath}`);
}

export async function mdmRemove(
  options: MdmRemoveOptions,
  ctx: CommandInvocationContext,
  env: MdmEnvironment = defaultMdmEnvironment(),
): Promise<void> {
  const { console } = ctx;
  await removeBinary(env.binaryPath);
  if (pathExistsOrLinked(env.binaryPath)) {
    throw new CommandFailedError(`Failed to remove ${env.binaryPath}.`);
  }
  console.text(`MDM binary removed from ${env.binaryPath}.`);
  if (isWindows() && !env.skipMachineIntegration) {
    await removeFromMachinePath(dirname(env.binaryPath));
  }
  if (options.mdmBinaryOnly) {
    return;
  }

  await removeRemainingBinariesOnPath(ctx);
  await removeStandaloneInstalls(env, ctx);
  console.success('SonarQube CLI removed.');
}
