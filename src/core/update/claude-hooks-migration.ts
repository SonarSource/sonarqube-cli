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

// Legacy Claude Code hook migration, consumed by the post-update mechanism
// that runs automatically after CLI upgrades.

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import logger from '../observability/logger.ts';
import type { CliState, HookExtension } from '../state/state.ts';
import { loadState } from '../state/state-repository.ts';
import {
  migrateHookScripts,
  OBSOLETE_A3S_MARKER,
  removeObsoleteHookArtifacts,
} from './migration.ts';

/**
 * Signature of `@/commands/integrate/claude/hooks.ts`'s `installHooks`,
 * injected by the CLI composition root so this module (which lives in
 * `core/` and must not depend on `commands/`) doesn't need to import it.
 */
export type InstallHooksFn = (
  projectRoot: string,
  globalDir: string | undefined,
  installSqaa: boolean,
) => Promise<void>;

/**
 * Migrate Claude Code hook scripts and reinstall secrets hooks for all known locations.
 *
 * Location discovery strategy:
 * 1. If agentExtensions registry has claude-code entries → use those (new format).
 * 2. Fallback for pre-registry installs: if agent is configured but registry is empty,
 *    check whether global hooks exist in homedir()/.claude and migrate there.
 *    Project-level hooks without registry entries cannot be discovered — user must
 *    re-run `sonar integrate claude` once to populate the registry.
 *
 * installSqaa is always false here: SQAA entitlement check requires a token which
 * is not available during post-update. User re-runs `sonar integrate claude` to
 * get the SQAA hook installed.
 *
 * @param homedirFn - Injectable for tests; defaults to os.homedir()
 */
export async function migrateClaudeCodeHooks(
  installHooksFn: InstallHooksFn,
  claudeIntegrationId: string,
  homedirFn: () => string = homedir,
): Promise<void> {
  const state = loadState();

  if (hasInstalledDeclarativeIntegration(state, claudeIntegrationId)) {
    logger.debug('Declarative Claude Code integration detected — skipping legacy hook migration');
    return;
  }

  const locations = resolveLocations(state, homedirFn);

  for (const { projectRoot, globalDir } of locations) {
    try {
      migrateHookScripts(projectRoot, globalDir);
      await installHooksFn(projectRoot, globalDir, false);
      await removeObsoleteHookArtifacts(projectRoot, OBSOLETE_A3S_MARKER);
      logger.debug(`Migrated Claude Code hooks for: ${globalDir ?? projectRoot}`);
    } catch (err) {
      logger.debug(
        `Hook migration failed for ${globalDir ?? projectRoot}: ${(err as Error).message}`,
      );
    }
  }
}

type Location = { projectRoot: string; globalDir: string | undefined };

function resolveLocations(state: CliState, homedirFn: () => string): Location[] {
  const extensions = state.agentExtensions.filter(
    (e): e is HookExtension => e.agentId === 'claude-code' && e.kind === 'hook',
  );

  if (extensions.length > 0) {
    // New format: use registry entries, deduplicate by (projectRoot, globalDir)
    const locations: Location[] = [];
    const seen = new Set<string>();
    for (const ext of extensions) {
      const globalDir = ext.global ? homedirFn() : undefined;
      const key = `${ext.projectRoot}|${globalDir ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push({ projectRoot: ext.projectRoot, globalDir });
    }
    return locations;
  }

  if (state.agents['claude-code'].configured) {
    // Pre-registry fallback: check for global hooks in homedir
    const globalHooksDir = join(homedirFn(), '.claude', 'hooks', 'sonar-secrets');
    if (fs.existsSync(globalHooksDir)) {
      return [{ projectRoot: homedirFn(), globalDir: homedirFn() }];
    }
  }

  return [];
}

function hasInstalledDeclarativeIntegration(state: CliState, integrationId: string): boolean {
  return state.integrations.installed.some(
    (entry) => entry.integrationId === integrationId && entry.features.length > 0,
  );
}
