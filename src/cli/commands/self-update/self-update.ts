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

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isWindows } from '../../../lib/platform-detector';
import { stripBuildNumber } from '../../../lib/version';
import { blank, info, success, text, warn } from '../../../ui';
import { CommandFailedError } from '../_common/error';
import { checkForUpdate } from './update-check';

export interface SelfUpdateOptions {
  status?: boolean;
  force?: boolean;
}

async function selfUpdateStatus(): Promise<void> {
  info('Checking for updates...');

  const { currentVersion, latestVersion, updateAvailable } = await checkForUpdate();

  const displayLatest = stripBuildNumber(latestVersion);
  text(`Current version: v${currentVersion}`);
  text(`Latest version:  v${displayLatest}`);
  blank();

  if (updateAvailable) {
    warn(`Update available: v${displayLatest}`);
    text('  Run: sonar self-update');
  } else {
    success('Already up to date');
  }
}

export async function selfUpdate(options: SelfUpdateOptions = {}): Promise<void> {
  if (options.status) {
    await selfUpdateStatus();
    return;
  }

  info('Checking for updates...');

  const { currentVersion, latestVersion, updateAvailable, scriptContent, scriptName } =
    await checkForUpdate();

  if (!updateAvailable && !options.force) {
    success(`Already up to date (v${currentVersion})`);
    return;
  }

  if (updateAvailable) {
    info(`Updating v${currentVersion} → v${latestVersion}...`);
  } else {
    info(`Force installing v${latestVersion}...`);
  }

  const tempPath = join(tmpdir(), scriptName);

  if (isWindows()) {
    // On Windows the running binary is file-locked, so the parent must exit immediately
    // so that the script can overwrite the executable. Otherwise, the update will fail and
    // has to be manually retried by the user.
    // Open PowerShell in a new window so it has its own console and the user can see the output.
    writeFileSync(tempPath, scriptContent, 'utf8');
    info('Starting update in a new terminal window...');
    // The ComSpec environment variable (always points to the system cmd.exe)
    const cmdExe = process.env.ComSpec ?? String.raw`C:\Windows\System32\cmd.exe`;
    const child = spawn(
      cmdExe,
      ['/c', 'start', 'powershell', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', tempPath],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    text('Check the new terminal window to confirm the update completed.');
  } else {
    // On Unix the binary is not locked, so run the script synchronously and
    // stream its output directly to the terminal.
    writeFileSync(tempPath, scriptContent, { encoding: 'utf8', mode: 0o755 });
    const result = spawnSync('/bin/bash', [tempPath], { stdio: 'inherit' });
    if (result.status !== 0) {
      throw new CommandFailedError(
        `Update script exited with code ${String(result.status ?? 'unknown')}`,
        {
          remediationHint:
            "Rerun 'sonar self-update --force' or update manually using the installer script.",
        },
      );
    }
    success(`Updated to v${latestVersion}`);
  }
}
