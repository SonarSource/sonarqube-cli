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
import { Version } from '../_common/version';
import { checkForUpdate } from './update-check';

export interface SelfUpdateOptions {
  status?: boolean;
  force?: boolean;
  version?: string;
  artifactBaseUrl?: string;
}

async function selfUpdateStatus(artifactBaseUrl?: string): Promise<void> {
  info('Checking for updates...');

  const { currentVersion, latest, upToDate } = await checkForUpdate({ artifactBaseUrl });

  text(`Current version: v${currentVersion.text}`);
  text(`Latest version:  v${latest.version.noBuild.text}`);
  blank();

  if (upToDate) {
    success('Already up to date');
  } else {
    warn(`Update available: v${latest.version.noBuild.text}`);
    text('  Run: sonar self-update');
  }
}

export async function selfUpdate(options: SelfUpdateOptions = {}): Promise<void> {
  if (options.status) {
    await selfUpdateStatus(options.artifactBaseUrl);
    return;
  }

  info('Checking for updates...');

  const { currentVersion, latest, upToDate } = await checkForUpdate({
    artifactBaseUrl: options.artifactBaseUrl,
  });

  const pinnedVersion = options.version ? new Version(options.version) : null;
  const displayTarget = pinnedVersion ? pinnedVersion.noBuild.text : latest.version.noBuild.text;
  const pinnedMatchesCurrent = pinnedVersion?.noBuild.text === currentVersion.noBuild.text;

  if ((upToDate || pinnedMatchesCurrent) && !options.force) {
    success(`Already up to date (v${currentVersion.text})`);
    return;
  }

  if (pinnedVersion) {
    info(`Installing v${displayTarget} (current: v${currentVersion.text})...`);
  } else if (upToDate) {
    info(`Force installing v${displayTarget}...`);
  } else {
    info(`Updating v${currentVersion.text} → v${displayTarget}...`);
  }

  const installResult = await latest.install({
    version: options.version,
    force: options.force,
    artifactBaseUrl: options.artifactBaseUrl,
  });
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
          "Rerun 'sonar self-update --force' or update manually using the installer script.",
      });
    }
    case 'installed':
      success(`Updated to v${displayTarget}`);
  }
}
