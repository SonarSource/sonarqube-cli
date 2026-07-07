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

import { blank, info, success, text, warn } from '../../../ui';
import { CommandFailedError } from '../_common/error';
import { checkForUpdate } from './update-check';

export interface UpdateVersionOptions {
  status?: boolean;
  force?: boolean;
}

async function updateVersionStatus(): Promise<void> {
  info('Checking for updates...');

  const { currentVersion, latest, upToDate } = await checkForUpdate();

  text(`Current version: v${currentVersion.text}`);
  text(`Latest version:  v${latest.version.noBuild.text}`);
  blank();

  if (upToDate) {
    success('Already up to date');
  } else {
    warn(`Update available: v${latest.version.noBuild.text}`);
    text('  Run: sonar update');
  }
}

export async function updateVersion(options: UpdateVersionOptions = {}): Promise<void> {
  if (options.status) {
    await updateVersionStatus();
    return;
  }

  info('Checking for updates...');

  const { currentVersion, latest, upToDate } = await checkForUpdate();
  const latestVersion = latest.version.noBuild.text;

  if (upToDate && !options.force) {
    success(`Already up to date (v${currentVersion.text})`);
    return;
  }

  if (upToDate) {
    info(`Force installing v${latestVersion}...`);
  } else {
    info(`Updating v${currentVersion.text} → v${latestVersion}...`);
  }

  const installResult = await latest.install();
  switch (installResult.status) {
    case 'launched_in_new_terminal':
      info('Starting update in a new terminal window...');
      text('Check the new terminal window to confirm the update completed.');
      return;
    case 'failed': {
      const message = installResult.scriptErrorMessage
        ? `Failed to start update script: ${installResult.scriptErrorMessage}`
        : `Update script exited with code ${String(installResult.scriptExitStatus ?? 'unknown')}`;
      throw new CommandFailedError(message, {
        remediationHint:
          "Rerun 'sonar update --force' or update manually using the installer script.",
      });
    }
    case 'installed':
      success(`Updated to v${latestVersion}`);
  }
}
