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

import {
  type IntegrationRegistry,
  reconcileInstalledIntegrations,
} from '@/core/framework/features';

import { version as CURRENT_VERSION } from '../../../package.json';
import logger from '../observability/logger.ts';
import { loadState, saveState, stateFileExists, tryLoadState } from '../state/state-repository.ts';
import { isNewerVersion } from '../version.ts';
import { updateScaScannerBinaryIfNeeded, updateSecretsBinaryIfNeeded } from './binary-refresh.ts';
import {
  cleanObsoleteFromState,
  type InstallHooksFn,
  migrateClaudeCodeHooks,
} from './claude-hooks-migration.ts';
import { migrateLegacyTelemetryEvents } from './telemetry-migration.ts';

/**
 * Command-layer values `post-update` needs but must not import directly
 * (this module lives in `core/`, which must not depend on `commands/`).
 * The CLI composition root (`src/index.ts`) supplies these.
 */
export interface PostUpdateDependencies {
  /** Full registry of declarative integrations (`@/commands/integrate`). */
  supportedIntegrations: IntegrationRegistry;
  /** Claude Code's integration id (`@/commands/integrate/claude/declaration.ts`). */
  claudeIntegrationId: string;
  /** Installs/refreshes Claude Code hook scripts (`@/commands/integrate/claude/hooks.ts`). */
  installHooks: InstallHooksFn;
}

/**
 * Runs any actions that need to happen once after the CLI has been updated.
 *
 * - Skipped entirely when the state file is absent (fresh installation).
 * - Skipped when the persisted CLI version matches or exceeds the current binary version.
 * - On success the persisted CLI version is bumped to `CURRENT_VERSION` so the
 *   actions are not repeated on the next invocation.
 */
export async function runPostUpdateActions(deps: PostUpdateDependencies): Promise<void> {
  if (!stateFileExists()) {
    // No state file means this is a fresh installation — nothing to migrate.
    return;
  }

  const previousState = tryLoadState();
  if (!previousState) {
    return;
  }
  const previousVersion = previousState.config.cliVersion;

  if (!isNewerVersion(previousVersion, CURRENT_VERSION)) {
    return;
  }

  logger.debug(`Running post-update actions (${previousVersion} → ${CURRENT_VERSION})`);

  try {
    await runActions(deps);
    // Reload state to pick up changes made by subroutines
    // (migrateDeclarativeIntegrations, migrateClaudeCodeHooks,
    // updateSecretsBinaryIfNeeded) that load and save their own state copies.
    const state = loadState();
    state.config.cliVersion = CURRENT_VERSION;
    cleanObsoleteFromState(state);
    saveState(state);
  } catch (error) {
    logger.debug(`Post-update actions failed: ${(error as Error).message}`);
  }
}

async function runActions(deps: PostUpdateDependencies): Promise<void> {
  migrateLegacyTelemetryEvents();
  await migrateDeclarativeIntegrations(deps.supportedIntegrations);
  await migrateClaudeCodeHooks(deps.installHooks, deps.claudeIntegrationId);
  await updateSecretsBinaryIfNeeded();
  await updateScaScannerBinaryIfNeeded();
}

/**
 * Replays every registered integration's declared features against what is
 * currently recorded in state (see reconcileInstalledIntegrations), then
 * persists the result if anything changed.
 */
export async function migrateDeclarativeIntegrations(registry: IntegrationRegistry): Promise<void> {
  const state = loadState();
  if (await reconcileInstalledIntegrations(state, registry)) {
    saveState(state);
  }
}
