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

import type { Command } from 'commander';

import {
  SonarCommand,
  type UpdateNotificationCondition,
} from '@/commands/_common/sonar-command.ts';
import { Version } from '@/commands/_common/version.ts';
import {
  BACKGROUND_UPDATE_CHECK_TIMEOUT_MS,
  fetchLatestVersion,
} from '@/commands/update/update-check.ts';
import { TELEMETRY_FLUSH_MODE_ENV } from '@/core/telemetry';
import { isFormattedOutputMode, text } from '@/core/ui';
import { cyan } from '@/core/ui/colors.ts';

import { version as CURRENT_VERSION } from '../../../package.json';
import type { CliUpdateCheckState } from '../state/state.ts';
import { loadState, saveState } from '../state/state-manager.ts';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function collectCommandOpts(command: Command): Record<string, unknown> {
  const names: Command[] = [];
  let current: Command | null = command;
  while (current.parent !== null) {
    names.unshift(current);
    current = current.parent;
  }

  const merged: Record<string, unknown> = {};
  for (const cmd of names) {
    Object.assign(merged, cmd.opts());
  }
  return merged;
}

function resolveUpdateNotification(
  command: Command,
): true | UpdateNotificationCondition | undefined {
  let current: Command | null = command;
  while (current !== null) {
    if (current instanceof SonarCommand) {
      const when = current.showUpdateNotificationWhen;
      if (when !== undefined) {
        return when;
      }
    }
    current = current.parent;
  }
  return undefined;
}

export function isUpdateNotificationEligible(command: Command): boolean {
  return resolveUpdateNotification(command) !== undefined;
}

export function shouldSuppressUpdateNotification(command: Command): boolean {
  if (process.env[TELEMETRY_FLUSH_MODE_ENV]) {
    return true;
  }
  if (process.env.CI === 'true') {
    return true;
  }
  if (!process.stderr.isTTY || !process.stdout.isTTY) {
    return true;
  }
  if (isFormattedOutputMode()) {
    return true;
  }

  const when = resolveUpdateNotification(command);
  if (typeof when === 'function' && !when(collectCommandOpts(command))) {
    return true;
  }

  return false;
}

function isWithinCooldown(isoTimestamp: string | undefined, cooldownMs: number): boolean {
  if (!isoTimestamp) {
    return false;
  }
  const elapsed = Date.now() - Date.parse(isoTimestamp);
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < cooldownMs;
}

async function resolveLatestVersion(
  updateCheck: CliUpdateCheckState | undefined,
): Promise<{ latestVersion: string | undefined; updateCheck: CliUpdateCheckState }> {
  if (isWithinCooldown(updateCheck?.lastCheckedAt, ONE_DAY_MS)) {
    // Checked within the last day: reuse the cached result (which is undefined
    // when the previous check failed) instead of hitting the network again.
    return {
      latestVersion: updateCheck?.latestVersion,
      updateCheck: { ...updateCheck },
    };
  }

  const lastCheckedAt = new Date().toISOString();
  try {
    const latestVersion = await fetchLatestVersion(BACKGROUND_UPDATE_CHECK_TIMEOUT_MS);
    return {
      latestVersion,
      updateCheck: { ...updateCheck, lastCheckedAt, latestVersion },
    };
  } catch {
    // Record the attempt so a failing check does not re-hit the network — and
    // stall the command for up to the fetch timeout — on every invocation.
    // Any previously cached version is preserved so we can still notify from it.
    return {
      latestVersion: updateCheck?.latestVersion,
      updateCheck: { ...updateCheck, lastCheckedAt },
    };
  }
}

function renderUpdateNotification(currentNoBuild: string, latestNoBuild: string): void {
  // Keep the whole notice on stderr so it never contaminates a command's stdout.
  text('', undefined, 'stderr');
  text(
    `  ${cyan('ℹ')}  A new version of SonarQube CLI is available: ${currentNoBuild} → ${latestNoBuild}`,
    undefined,
    'stderr',
  );
  text(`   → Run \`sonar update\` to update to v${latestNoBuild}`, undefined, 'stderr');
}

/**
 * After eligible interactive commands, fetch binaries.sonarsource.com at most once
 * per day and print a stderr notice when a newer stable version exists.
 */
export async function maybeNotifyUpdateAvailable(command: Command): Promise<void> {
  if ((process.exitCode ?? 0) !== 0) {
    return;
  }
  if (shouldSuppressUpdateNotification(command) || !isUpdateNotificationEligible(command)) {
    return;
  }

  try {
    const state = loadState();
    const currentVersion = new Version(CURRENT_VERSION);
    const currentNoBuild = currentVersion.noBuild.text;

    const resolved = await resolveLatestVersion(state.config.updateCheck);

    // Persist the fetch timestamp on every attempt (success or failure) so the
    // remote version check stays throttled to once per day.
    state.config.updateCheck = resolved.updateCheck;
    saveState(state);

    if (!resolved.latestVersion) {
      return;
    }

    const latestVersion = new Version(resolved.latestVersion);
    const latestNoBuild = latestVersion.noBuild.text;

    if (!latestVersion.noBuild.isNewerThan(currentVersion)) {
      return;
    }

    renderUpdateNotification(currentNoBuild, latestNoBuild);
  } catch {
    // Best-effort only — never fail the user's command because of update metadata.
  }
}
