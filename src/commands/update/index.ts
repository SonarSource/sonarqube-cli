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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolveFormatOption } from '@/core/commands/parsing.ts';

import { checkForUpdate } from './update-check.ts';

export const VALID_FORMATS = ['text', 'json'] as const;

export interface UpdateVersionOptions {
  /** Deprecated CLI flag, kept working as an alias for the `update status` subcommand. */
  status?: boolean;
  force?: boolean;
}

export interface UpdateStatusOptions {
  format?: string;
}

/** `sonar update status` — reports the current and latest CLI version without installing. */
export async function updateStatus(
  options: UpdateStatusOptions,
  ctx: CommandInvocationContext,
): Promise<void> {
  const { console } = ctx;
  const format = resolveFormatOption(options.format, VALID_FORMATS, 'text');

  if (format !== 'json') {
    console.info('Checking for updates...');
  }

  const { currentVersion, latest, upToDate } = await checkForUpdate();
  const latestVersion = latest.version.noBuild.text;

  if (format === 'json') {
    console.print(
      JSON.stringify({ currentVersion: currentVersion.text, latestVersion, upToDate }, null, 2),
    );
    return;
  }

  console.text(`Current version: v${currentVersion.text}`);
  console.text(`Latest version:  v${latestVersion}`);
  console.blank();

  if (upToDate) {
    console.success('Already up to date');
  } else {
    console.warn(`Update available: v${latestVersion}`);
    console.text('  Run: sonar update');
  }
}

export async function updateVersion(
  options: UpdateVersionOptions,
  ctx: CommandInvocationContext,
): Promise<void> {
  const { console } = ctx;
  if (options.status) {
    // Deprecated flag: delegate to the same logic as the `update status` subcommand.
    await updateStatus({}, ctx);
    return;
  }

  console.info('Checking for updates...');

  const { currentVersion, latest, upToDate } = await checkForUpdate();
  const latestVersion = latest.version.noBuild.text;

  if (upToDate && !options.force) {
    console.success(`Already up to date (v${currentVersion.text})`);
    return;
  }

  if (upToDate) {
    console.info(`Force installing v${latestVersion}...`);
  } else {
    console.info(`Updating v${currentVersion.text} → v${latestVersion}...`);
  }

  const installResult = await latest.install();
  switch (installResult.status) {
    case 'launched_in_new_terminal':
      console.info('Starting update in a new terminal window...');
      console.text('Check the new terminal window to confirm the update completed.');
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
      console.success(`Updated to v${latestVersion}`);
  }
}
