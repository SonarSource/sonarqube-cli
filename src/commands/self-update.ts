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

// CLI self-update command

import { version as VERSION } from '../../package.json';
import {
  fetchLatestCliVersion,
  compareVersions,
  performSelfUpdate,
} from '../lib/self-update.js';
import { text, blank, success, warn, info, withSpinner } from '../ui/index.js';

/**
 * Core version check: compare current version against latest, return update info.
 */
async function checkVersion(): Promise<{
  current: string;
  latest: string;
  hasUpdate: boolean;
}> {
  const latest = await withSpinner('Checking for updates', fetchLatestCliVersion);
  const hasUpdate = compareVersions(latest, VERSION) > 0;
  return { current: VERSION, latest, hasUpdate };
}

/**
 * sonar self-update --check
 * Check for updates and notify the user, but do not install.
 */
export async function selfUpdateCheckCommand(): Promise<void> {
  text(`\nCurrent version: v${VERSION}\n`);

  const { latest, hasUpdate } = await checkVersion();

  if (!hasUpdate) {
    blank();
    success(`Already on the latest version (v${VERSION})`);
    return;
  }

  blank();
  warn(`Update available: v${VERSION} → v${latest}`);
  text(`  Run: sonar self-update`);
}

/**
 * sonar self-update
 * Check for updates and install if one is available (binary installs only).
 * With --force, reinstall even if already on the latest version.
 */
export async function selfUpdateCommand(options: { check?: boolean; force?: boolean }): Promise<void> {
  if (options.check) {
    await selfUpdateCheckCommand();
    return;
  }

  text(`\nCurrent version: v${VERSION}\n`);

  const { latest, hasUpdate } = await checkVersion();

  if (options.force) {
    info(`Forcing reinstall of v${latest}`);
  } else if (hasUpdate) {
    info(`Update available: v${VERSION} → v${latest}`);
  } else {
    blank();
    success(`Already on the latest version (v${VERSION})`);
    return;
  }

  blank();
  await withSpinner(
    `Installing v${latest}`,
    performSelfUpdate
  );

  blank();
  success(`Updated to v${latest}`);
}
