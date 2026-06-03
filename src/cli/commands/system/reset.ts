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

import { existsSync, rmSync } from 'node:fs';

import { version as VERSION } from '../../../../package.json';
import { LOG_DIR } from '../../../lib/config-constants';
import { deleteToken } from '../../../lib/keychain';
import { loadState, saveState } from '../../../lib/repository/state-repository';
import { type CliState, getDefaultState, type InstalledIntegration } from '../../../lib/state';
import type { PhaseItem } from '../../../ui';
import { phase, phaseItem, print, success, text, textPrompt, warn } from '../../../ui';

export interface SystemResetOptions {
  force?: boolean;
}

/**
 * What each reset step successfully cleaned — used to surgically subtract
 * cleaned entries from state rather than wiping everything unconditionally.
 */
interface CleanedFields {
  authConnectionIds: string[];
  dependencyIds: string[];
  integrationFeatures: Array<{ integrationStateId: string; featureId: string }>;
  agentExtensionIds: string[];
}

interface StepResult {
  item: PhaseItem;
  cleaned: CleanedFields;
}

function emptyCleanedFields(overrides: Partial<CleanedFields> = {}): CleanedFields {
  return {
    authConnectionIds: [],
    dependencyIds: [],
    integrationFeatures: [],
    agentExtensionIds: [],
    ...overrides,
  };
}

function mergeCleanedFields(fields: CleanedFields[]): CleanedFields {
  return {
    authConnectionIds: fields.flatMap((f) => f.authConnectionIds),
    dependencyIds: fields.flatMap((f) => f.dependencyIds),
    integrationFeatures: fields.flatMap((f) => f.integrationFeatures),
    agentExtensionIds: fields.flatMap((f) => f.agentExtensionIds),
  };
}

/**
 * Reset the CLI to factory defaults: remove tokens, binaries, integrations,
 * and cached files. Telemetry settings are preserved.
 */
export async function systemReset(options: SystemResetOptions): Promise<void> {
  if (!(options.force || (await confirmDestructiveAction()))) {
    return;
  }

  const state = loadState();

  const results: StepResult[] = [
    await purgeAuth(state),
    removeBinaries(),
    removeAllIntegrations(),
    clearFilesystem(),
  ];

  phase(
    'Reset',
    results.map((r) => r.item),
  );

  applyCleanedState(state, mergeCleanedFields(results.map((r) => r.cleaned)));
  clearLegacyState(state);
  saveState(state);

  const hasIssues = results.some((r) => r.item.status === 'warn' || r.item.status === 'pending');
  if (hasIssues) {
    text(
      'CLI has been partially reset. Review the details above and clean up remaining items manually.',
    );
  } else {
    success('CLI has been successfully reset to factory settings.');
  }
}

async function confirmDestructiveAction(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    print('Reset cancelled. Use --force to skip the prompt in non-interactive mode.');
    return false;
  }
  warn(
    'This will remove all local credentials, uninstall Sonar binaries, and break active tools integrations.',
  );
  const answer = await textPrompt('Please type RESET to continue');
  if (answer?.trim() !== 'RESET') {
    print('Reset cancelled.');
    return false;
  }
  return true;
}

async function purgeAuth(state: CliState): Promise<StepResult> {
  const cleanedIds: string[] = [];
  const failed: string[] = [];

  for (const conn of state.auth.connections) {
    const target = conn.orgKey ? `${conn.serverUrl} (${conn.orgKey})` : conn.serverUrl;
    try {
      await deleteToken(conn.serverUrl, conn.orgKey);
      cleanedIds.push(conn.id);
    } catch (err) {
      failed.push(`${target}: ${(err as Error).message}`);
    }
  }

  let item: PhaseItem;
  if (failed.length > 0) {
    const counts =
      cleanedIds.length > 0
        ? `${cleanedIds.length} removed, ${failed.length} failed`
        : `${failed.length} failed`;
    item = phaseItem('Authentication', 'warn', `${counts}: ${failed.join('; ')}`);
  } else {
    item = phaseItem(
      'Authentication',
      'done',
      `${cleanedIds.length} tokens removed from keychain.`,
    );
  }

  return { item, cleaned: emptyCleanedFields({ authConnectionIds: cleanedIds }) };
}

function removeBinaries(): StepResult {
  // Stub: CLI-565 deletes binary files recorded in state.dependencies.installed[]
  // via the declarative framework's WholeFileResource.remove(), returning dependencyIds
  // for each file confirmed deleted so applyCleanedState can remove them from state.
  return {
    item: phaseItem('Binaries', 'pending', 'Pending CLI-565.'),
    cleaned: emptyCleanedFields(),
  };
}

function removeAllIntegrations(): StepResult {
  // Stub: CLI-565 iterates ALL_INTEGRATIONS, calls IntegrationInstaller.removeFeature()
  // per installed feature (added in CLI-562), and returns integrationFeatures + agentExtensionIds
  // for each successfully removed feature so applyCleanedState can subtract them from state.
  return {
    item: phaseItem('Integrations', 'pending', 'Pending CLI-565.'),
    cleaned: emptyCleanedFields(),
  };
}

function clearFilesystem(): StepResult {
  const result = tryRemoveDir(LOG_DIR);
  let item: PhaseItem;
  if (result.error !== undefined) {
    item = phaseItem('Filesystem', 'warn', `Failed to remove ${LOG_DIR}: ${result.error}`);
  } else if (result.removed) {
    item = phaseItem('Filesystem', 'done', `Cleared ${LOG_DIR}.`);
  } else {
    item = phaseItem('Filesystem', 'info', 'Nothing to clear.');
  }
  return { item, cleaned: emptyCleanedFields() };
}

function indexCleanedFeatures(
  features: Array<{ integrationStateId: string; featureId: string }>,
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const { integrationStateId, featureId } of features) {
    let ids = index.get(integrationStateId);
    if (!ids) {
      ids = new Set();
      index.set(integrationStateId, ids);
    }
    ids.add(featureId);
  }
  return index;
}

function removeCleanedFeatures(
  integration: InstalledIntegration,
  cleanedFeatures: Map<string, Set<string>>,
): InstalledIntegration {
  const cleanedIds = cleanedFeatures.get(integration.id);
  return {
    ...integration,
    features: cleanedIds
      ? integration.features.filter((f) => !cleanedIds.has(f.featureId))
      : integration.features,
  };
}

function tryRemoveDir(dir: string): { removed: boolean; error?: string } {
  try {
    if (!existsSync(dir)) return { removed: false };
    rmSync(dir, { recursive: true, force: true });
    return { removed: true };
  } catch (err) {
    return { removed: false, error: (err as Error).message };
  }
}

/**
 * Subtract successfully-cleaned entries from state. Only entries confirmed
 * removed are dropped — failures remain in state so the user can retry or
 * clean up manually.
 */
function applyCleanedState(state: CliState, cleaned: CleanedFields): void {
  if (cleaned.authConnectionIds.length > 0) {
    const removedIds = new Set(cleaned.authConnectionIds);
    state.auth.connections = state.auth.connections.filter((c) => !removedIds.has(c.id));
    state.auth.isAuthenticated = state.auth.connections.length > 0;
    if (
      state.auth.activeConnectionId !== undefined &&
      !state.auth.connections.some((c) => c.id === state.auth.activeConnectionId)
    ) {
      state.auth.activeConnectionId = undefined;
    }
  }

  if (cleaned.dependencyIds.length > 0) {
    const removedIds = new Set(cleaned.dependencyIds);
    state.dependencies.installed = state.dependencies.installed.filter(
      (d) => !removedIds.has(d.id),
    );
  }

  if (cleaned.integrationFeatures.length > 0) {
    const cleanedFeatures = indexCleanedFeatures(cleaned.integrationFeatures);
    state.integrations.installed = state.integrations.installed
      .map((i) => removeCleanedFeatures(i, cleanedFeatures))
      .filter((i) => i.features.length > 0);
  }

  if (cleaned.agentExtensionIds.length > 0) {
    const removedIds = new Set(cleaned.agentExtensionIds);
    state.agentExtensions = state.agentExtensions.filter((e) => !removedIds.has(e.id));
  }
}

/**
 * Clear legacy state fields that carry no physical artifacts and are not
 * tracked by the declarative framework — safe to drop unconditionally.
 */
function clearLegacyState(state: CliState): void {
  const defaults = getDefaultState(VERSION);
  state.agents = defaults.agents;
  state.tools = defaults.tools;
  state.lastUpdated = new Date().toISOString();
}
