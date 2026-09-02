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

import { type CliState, getDefaultState, type InstalledIntegration } from '@/core/state/state.ts';
import { loadState, saveState } from '@/core/state/state-repository.ts';
import type { PhaseItem } from '@/core/ui';
import { info, phase, print, success, text, textPrompt, warn } from '@/core/ui';
import { printAgentNonInteractiveAlternativeHint } from '@/core/ui/components/agent-prompt-hint.ts';

import { version as VERSION } from '../../../package.json';
import { supportedIntegrations } from '../integrate';
import { purgeAuth } from './reset-auth.ts';
import { removeBinaries } from './reset-binaries.ts';
import { clearFilesystem } from './reset-filesystem.ts';
import { removeAllIntegrations } from './reset-integrations.ts';

export interface SystemResetOptions {
  force?: boolean;
}

interface CleanedFields {
  authConnectionIds: string[];
  dependencyIds: string[];
  integrationFeatures: Array<{ integrationStateId: string; featureId: string }>;
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
    ...overrides,
  };
}

function mergeCleanedFields(fields: CleanedFields[]): CleanedFields {
  return {
    authConnectionIds: fields.flatMap((f) => f.authConnectionIds),
    dependencyIds: fields.flatMap((f) => f.dependencyIds),
    integrationFeatures: fields.flatMap((f) => f.integrationFeatures),
  };
}

/**
 * Reset the CLI to factory defaults: remove tokens, binaries, integrations,
 * and cached files. Telemetry settings are preserved.
 */
export async function systemReset(options: SystemResetOptions): Promise<void> {
  if (!options.force) {
    printAgentNonInteractiveAlternativeHint('sonar system reset --force');
    if (!(await confirmDestructiveAction())) {
      return;
    }
  }

  info('Cleaning up SonarQube CLI environment...');

  const state = loadState();
  const results: StepResult[] = [];

  try {
    const authResult = await purgeAuth(state);
    results.push({
      item: authResult.item,
      cleaned: emptyCleanedFields({ authConnectionIds: authResult.authConnectionIds }),
    });

    const binaryResult = await removeBinaries(state);
    results.push({
      item: binaryResult.item,
      cleaned: emptyCleanedFields({ dependencyIds: binaryResult.dependencyIds }),
    });

    const integrationResult = await removeAllIntegrations(state, supportedIntegrations);
    results.push({
      item: integrationResult.item,
      cleaned: emptyCleanedFields({
        integrationFeatures: integrationResult.integrationFeatures,
      }),
    });

    const filesystemResult = clearFilesystem();
    results.push({ item: filesystemResult.item, cleaned: emptyCleanedFields() });
  } finally {
    if (results.length > 0) {
      phase(
        'Reset',
        results.map((r) => r.item),
      );

      applyCleanedState(state, mergeCleanedFields(results.map((r) => r.cleaned)));
      clearLegacyState(state);
      // Not tied to any step above — would otherwise survive reset indefinitely.
      state.knownServerProjectMappings = [];
      saveState(state);
    }
  }

  const hasWarnings = results.some((r) => r.item.status === 'warn');

  if (hasWarnings) {
    text(
      'CLI has been partially reset. Review the details above and clean up remaining items manually.',
    );
    warn('System reset completed with warnings.');
    return;
  }

  success('CLI has been successfully reset to factory settings.');
}

async function confirmDestructiveAction(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    print('Reset cancelled. Use --force to skip the prompt in non-interactive mode.');
    return false;
  }
  warn(
    'This will remove all local credentials, uninstall Sonar binaries, and break active tool integrations.',
  );
  const answer = await textPrompt('Please type RESET to continue');
  if (answer?.trim() !== 'RESET') {
    print('Reset cancelled.');
    return false;
  }
  return true;
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
}

function clearLegacyState(state: CliState): void {
  const defaults = getDefaultState(VERSION);
  state.agents = defaults.agents;
  state.agentExtensions = defaults.agentExtensions;
  state.lastUpdated = new Date().toISOString();
}
