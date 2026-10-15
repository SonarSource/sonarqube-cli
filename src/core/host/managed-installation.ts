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

import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { InvalidArgumentError } from 'commander';

import { isWindows } from '@/core/host/environment/platform-detector.ts';

export const MANAGED_INSTALLATION_MARKER_NAME = 'sonar.managed';
export const DEFAULT_MANAGED_INSTALLATION_MESSAGE =
  'This SonarQube CLI is managed by your organization. Contact your administrator to change the installed version.';

const MAX_MESSAGE_LENGTH = 1000;
const MARKER_MODE = 0o644;

/**
 * Validates the text an administrator wants `sonar update` to show on a managed installation.
 *
 * @param value - Raw option value.
 * @returns The trimmed message.
 */
export function parseManagedMessageOption(value: string): string {
  const message = value.trim();
  if (message === '') {
    throw new InvalidArgumentError('Must not be empty.');
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new InvalidArgumentError(`Must be at most ${String(MAX_MESSAGE_LENGTH)} characters.`);
  }
  return message;
}

/**
 * Path of the marker file kept next to a binary. The directory of a system-wide install is only
 * writable by an administrator, so a regular user can neither add nor remove the marker.
 *
 * @param binaryPath - Path of the installed binary.
 * @returns Path of the marker file in the same directory.
 */
export function managedInstallationMarkerPath(binaryPath: string): string {
  return join(dirname(binaryPath), MANAGED_INSTALLATION_MARKER_NAME);
}

/**
 * Marks the installation of a binary as managed by an administrator.
 *
 * @param binaryPath - Path of the installed binary.
 * @param message - Text to show instead of updating. When omitted, an existing marker is kept
 * unchanged and a new one gets the default text.
 */
export function writeManagedInstallationMarker(binaryPath: string, message?: string): void {
  const markerPath = managedInstallationMarkerPath(binaryPath);
  if (message === undefined && existsSync(markerPath)) {
    return;
  }
  writeFileSync(markerPath, `${message ?? DEFAULT_MANAGED_INSTALLATION_MESSAGE}\n`);
  if (!isWindows()) {
    chmodSync(markerPath, MARKER_MODE);
  }
}

/**
 * Deletes the managed-installation marker next to a binary, if there is one.
 *
 * @param binaryPath - Path of the installed binary.
 */
export function removeManagedInstallationMarker(binaryPath: string): void {
  rmSync(managedInstallationMarkerPath(binaryPath), { force: true });
}

function resolveRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Tells whether the running CLI was installed by an administrator who does not want users to
 * update it themselves. Symbolic links are followed, so a per-user link to the system-wide
 * binary finds the marker next to the real file.
 *
 * @param executablePath - Path of the running executable.
 * @returns The message to show the user, or `null` when the installation is not managed.
 */
export function readManagedInstallationMessage(executablePath = process.execPath): string | null {
  const markerPath = managedInstallationMarkerPath(resolveRealPath(executablePath));
  if (!existsSync(markerPath)) {
    return null;
  }
  try {
    return readFileSync(markerPath, 'utf8').trim() || DEFAULT_MANAGED_INSTALLATION_MESSAGE;
  } catch {
    return DEFAULT_MANAGED_INSTALLATION_MESSAGE;
  }
}
