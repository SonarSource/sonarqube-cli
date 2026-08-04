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

import type { CliUpdateCheckState } from '@/core/state/state.ts';
import { loadState, saveState } from '@/core/state/state-manager.ts';
import { TELEMETRY_FLUSH_MODE_ENV } from '@/core/telemetry';
import { isWithinCooldown, ONE_DAY_MS } from '@/core/time/cooldown.ts';
import { isFormattedOutputMode, text } from '@/core/ui';
import { cyan } from '@/core/ui/colors.ts';
import { Version } from '@/core/version.ts';

import { version as CURRENT_VERSION } from '../../../package.json';
import { BACKGROUND_UPDATE_CHECK_TIMEOUT_MS, fetchLatestVersion } from './check.ts';

/** When to show the post-command update notice for an opted-in command. */
export type UpdateNotificationCondition = (opts: Record<string, unknown>) => boolean;

/**
 * Owns the per-command opt-in registry for the post-command "new version
 * available" stderr notice, plus the eligibility/suppression checks and the
 * actual throttled version check. There is no shared singleton here: the root
 * `SonarCommand` (commands/sonar-command.ts) owns one instance and
 * propagates it to every subcommand, so `showUpdateNotification()` can call
 * `register()` on it without this module depending on that class.
 */
export class UpdateNotifier {
  private readonly registry = new WeakMap<Command, true | UpdateNotificationCondition>();

  /** Opt a command into the post-command "new version available" stderr notice. */
  register(command: Command, when?: UpdateNotificationCondition): void {
    this.registry.set(command, when ?? true);
  }

  isEligible(command: Command): boolean {
    return this.resolve(command) !== undefined;
  }

  shouldSuppress(command: Command): boolean {
    if (process.env[TELEMETRY_FLUSH_MODE_ENV]) {
      return true;
    }
    if (process.env.CI === 'true') {
      return true;
    }
    if (!process.env.SONARQUBE_CLI_MOCK_TTY && (!process.stderr.isTTY || !process.stdout.isTTY)) {
      return true;
    }
    if (isFormattedOutputMode()) {
      return true;
    }

    const when = this.resolve(command);
    if (typeof when === 'function' && !when(this.collectOpts(command))) {
      return true;
    }

    return false;
  }

  /**
   * After eligible interactive commands, fetch binaries.sonarsource.com at most once
   * per day and print a stderr notice when a newer stable version exists.
   */
  async maybeNotify(command: Command): Promise<void> {
    if ((process.exitCode ?? 0) !== 0) {
      return;
    }
    if (this.shouldSuppress(command) || !this.isEligible(command)) {
      return;
    }

    try {
      const state = loadState();
      const currentVersion = new Version(CURRENT_VERSION);
      const currentNoBuild = currentVersion.noBuild.text;

      const resolved = await this.resolveLatestVersion(state.config.updateCheck);

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

      this.renderNotification(currentNoBuild, latestNoBuild);
    } catch {
      // Best-effort only — never fail the user's command because of update metadata.
    }
  }

  private resolve(command: Command): true | UpdateNotificationCondition | undefined {
    let current: Command | null = command;
    while (current !== null) {
      const when = this.registry.get(current);
      if (when !== undefined) {
        return when;
      }
      current = current.parent;
    }
    return undefined;
  }

  private collectOpts(command: Command): Record<string, unknown> {
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

  private async resolveLatestVersion(
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

  private renderNotification(currentNoBuild: string, latestNoBuild: string): void {
    // Keep the whole notice on stderr so it never contaminates a command's stdout.
    text('', undefined, 'stderr');
    text(
      `  ${cyan('ℹ')}  A new version of SonarQube CLI is available: ${currentNoBuild} → ${latestNoBuild}`,
      undefined,
      'stderr',
    );
    text(`   → Run \`sonar update\` to update to v${latestNoBuild}`, undefined, 'stderr');
  }
}
