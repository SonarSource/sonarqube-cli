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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  DEFAULT_MANAGED_INSTALLATION_MESSAGE,
  managedInstallationMarkerPath,
  parseManagedMessageOption,
  readManagedInstallationMessage,
  removeManagedInstallationMarker,
  writeManagedInstallationMarker,
} from '@/core/host/managed-installation.ts';

describe('managed installation marker', () => {
  let workDir: string;
  let binaryPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'managed-installation-'));
    mkdirSync(join(workDir, 'system'));
    binaryPath = join(workDir, 'system', 'sonar');
    writeFileSync(binaryPath, 'binary');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('reports no message when there is no marker', () => {
    expect(readManagedInstallationMessage(binaryPath)).toBeNull();
  });

  it('reads the trimmed text of the marker', () => {
    writeFileSync(managedInstallationMarkerPath(binaryPath), '  Ask IT.\n');

    expect(readManagedInstallationMessage(binaryPath)).toBe('Ask IT.');
  });

  it('falls back to the default text for an empty marker', () => {
    writeFileSync(managedInstallationMarkerPath(binaryPath), '\n');

    expect(readManagedInstallationMessage(binaryPath)).toBe(DEFAULT_MANAGED_INSTALLATION_MESSAGE);
  });

  it('finds the marker through a symbolic link to the binary', () => {
    mkdirSync(join(workDir, 'user'));
    const link = join(workDir, 'user', 'sonar');
    symlinkSync(binaryPath, link);
    writeManagedInstallationMarker(binaryPath, 'Ask IT.');

    expect(readManagedInstallationMessage(link)).toBe('Ask IT.');
  });

  it('does not treat a copy in another directory as managed', () => {
    mkdirSync(join(workDir, 'user'));
    const copy = join(workDir, 'user', 'sonar');
    writeFileSync(copy, 'binary');
    writeManagedInstallationMarker(binaryPath, 'Ask IT.');

    expect(readManagedInstallationMessage(copy)).toBeNull();
  });

  it('writes the default text only when no marker exists yet', () => {
    writeManagedInstallationMarker(binaryPath);
    expect(readManagedInstallationMessage(binaryPath)).toBe(DEFAULT_MANAGED_INSTALLATION_MESSAGE);

    writeManagedInstallationMarker(binaryPath, 'Ask IT.');
    writeManagedInstallationMarker(binaryPath);

    expect(readFileSync(managedInstallationMarkerPath(binaryPath), 'utf8').trim()).toBe('Ask IT.');
  });

  it('removes the marker and tolerates a missing one', () => {
    writeManagedInstallationMarker(binaryPath);

    removeManagedInstallationMarker(binaryPath);
    removeManagedInstallationMarker(binaryPath);

    expect(readManagedInstallationMessage(binaryPath)).toBeNull();
  });

  it('validates the message option', () => {
    expect(parseManagedMessageOption('  Ask IT.  ')).toBe('Ask IT.');
    expect(() => parseManagedMessageOption('   ')).toThrow();
    expect(() => parseManagedMessageOption('x'.repeat(1001))).toThrow();
  });
});
