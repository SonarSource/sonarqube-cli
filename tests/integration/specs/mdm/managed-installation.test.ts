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

import { existsSync, readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

import {
  DEFAULT_MANAGED_INSTALLATION_MESSAGE,
  managedInstallationMarkerPath,
} from '@/core/host/managed-installation.ts';

import { IS_WINDOWS, TestHarness } from '../../harness';
import { MdmSandbox } from './mdm-sandbox';

setDefaultTimeout(60_000);

const ADMIN_MESSAGE = 'Updates are rolled out by IT. Open a ticket at it.example.com.';

describe('mdm managed installation marker', () => {
  let harness: TestHarness;
  let sandbox: MdmSandbox;

  beforeEach(async () => {
    harness = await TestHarness.create();
    sandbox = new MdmSandbox(harness);
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function markerText(): string {
    return readFileSync(managedInstallationMarkerPath(sandbox.binaryPath), 'utf8').trim();
  }

  function updateByInstalledCli(binaryPath = sandbox.binaryPath) {
    return harness.run('update', { binaryPath });
  }

  it('install leaves the default message next to the binary', async () => {
    const result = await sandbox.run('install');

    expect(result.exitCode).toBe(0);
    expect(markerText()).toBe(DEFAULT_MANAGED_INSTALLATION_MESSAGE);
  });

  it('install --managed-message stores the administrator text', async () => {
    const result = await sandbox.run(`install --managed-message "${ADMIN_MESSAGE}"`);

    expect(result.exitCode).toBe(0);
    expect(markerText()).toBe(ADMIN_MESSAGE);
  });

  it('a reinstall without the option keeps the text, and with the option replaces it', async () => {
    await sandbox.run(`install --managed-message "${ADMIN_MESSAGE}"`);

    await sandbox.run('install');
    expect(markerText()).toBe(ADMIN_MESSAGE);

    await sandbox.run('install --managed-message "New text"');
    expect(markerText()).toBe('New text');
  });

  it('install rejects an empty message', async () => {
    const result = await sandbox.run('install --managed-message "  "');

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('Must not be empty');
    expect(existsSync(sandbox.binaryPath)).toBe(false);
  });

  it('sonar update on the installed CLI prints the message and updates nothing', async () => {
    await sandbox.run(`install --managed-message "${ADMIN_MESSAGE}"`);

    const result = await updateByInstalledCli();

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain(ADMIN_MESSAGE);
    expect(result.stdout + result.stderr).not.toContain('Checking for updates');
  });

  it('sonar update falls back to the default message when none was configured', async () => {
    await sandbox.run('install');

    const result = await updateByInstalledCli();

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('Contact your administrator');
  });

  it.skipIf(IS_WINDOWS)(
    'sonar update through the per-user link to the installed CLI also refuses',
    async () => {
      const standalone = sandbox.seedStandalone(0);
      await sandbox.run(`install --managed-message "${ADMIN_MESSAGE}"`);

      const result = await updateByInstalledCli(standalone);

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(ADMIN_MESSAGE);
    },
  );

  it('remove deletes the marker', async () => {
    await sandbox.run('install');

    await sandbox.run('remove');

    expect(existsSync(managedInstallationMarkerPath(sandbox.binaryPath))).toBe(false);
  });
});
