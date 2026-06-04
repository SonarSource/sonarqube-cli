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
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentExtension,
  CliState,
  HookExtension,
  InstalledIntegration,
  InstalledIntegrationFeature,
} from '../../../lib/state';
import type { PhaseItem } from '../../../ui';
import { phaseItem } from '../../../ui';
import { readOrInitJson, removeAgentHooks, SONAR_SECRETS_MARKER } from '../integrate/_common/hooks';
import {
  type IntegrationDeclaration,
  integrationInstaller,
  type IntegrationRegistry,
  makeContext,
} from '../integrate/_common/registry';
import { removeCopilotHookConfig } from '../integrate/copilot/hooks';

export interface IntegrationResetResult {
  item: PhaseItem;
  integrationFeatures: Array<{ integrationStateId: string; featureId: string }>;
  agentExtensionIds: string[];
}

/** Maps declarative integration ids to legacy `agentExtensions.agentId` values. */
const INTEGRATION_TO_AGENT_ID: Record<string, string> = {
  'claude-code': 'claude-code',
  'copilot-cli': 'copilot-cli',
  codex: 'codex',
};

type FeatureRemoveOutcome =
  | {
      status: 'removed';
      integrationStateId: string;
      featureId: string;
      agentExtensionIds: string[];
    }
  | { status: 'failed'; message: string };

interface DeclarativeIntegrationReset {
  integrationFeatures: Array<{ integrationStateId: string; featureId: string }>;
  agentExtensionIds: string[];
  failed: string[];
  removedFeatures: number;
}

export async function removeAllIntegrations(state: CliState): Promise<IntegrationResetResult> {
  const supportedIntegrations = await loadSupportedIntegrations();
  const declarative = await removeDeclarativeIntegrations(state, supportedIntegrations);
  const legacy = await removeLegacyAgentExtensions(state);

  const agentExtensionIds = [...new Set([...declarative.agentExtensionIds, ...legacy.cleanedIds])];
  const failed = [...declarative.failed, ...legacy.failed];
  const totalRemoved = declarative.removedFeatures + legacy.cleanedIds.length;

  return {
    item: buildIntegrationPhaseItem(totalRemoved, failed),
    integrationFeatures: declarative.integrationFeatures,
    agentExtensionIds,
  };
}

async function loadSupportedIntegrations(): Promise<IntegrationRegistry> {
  const { supportedIntegrations } = await import('../integrate/index.js');
  return supportedIntegrations;
}

async function removeDeclarativeIntegrations(
  state: CliState,
  supportedIntegrations: IntegrationRegistry,
): Promise<DeclarativeIntegrationReset> {
  const integrationFeatures: Array<{ integrationStateId: string; featureId: string }> = [];
  const agentExtensionIds: string[] = [];
  const failed: string[] = [];
  let removedFeatures = 0;

  for (const installed of state.integrations.installed) {
    const declaration = supportedIntegrations.get(installed.integrationId);
    if (!declaration) {
      failed.push(`${installed.integrationId}: unknown integration`);
      continue;
    }

    for (const installedFeature of installed.features) {
      const outcome = await tryRemoveInstalledFeature(
        state,
        installed,
        installedFeature,
        declaration,
      );
      if (outcome.status === 'removed') {
        integrationFeatures.push({
          integrationStateId: outcome.integrationStateId,
          featureId: outcome.featureId,
        });
        agentExtensionIds.push(...outcome.agentExtensionIds);
        removedFeatures += 1;
      } else {
        failed.push(outcome.message);
      }
    }
  }

  return { integrationFeatures, agentExtensionIds, failed, removedFeatures };
}

async function tryRemoveInstalledFeature(
  state: CliState,
  installed: InstalledIntegration,
  installedFeature: InstalledIntegrationFeature,
  declaration: IntegrationDeclaration,
): Promise<FeatureRemoveOutcome> {
  const featureDeclaration = declaration.features.find(
    (feature) => feature.id === installedFeature.featureId,
  );
  if (!featureDeclaration) {
    return {
      status: 'failed',
      message: `${installed.integrationId}.${installedFeature.featureId}: unknown feature`,
    };
  }

  const context = makeContext(
    state,
    installedFeature.targetRoot,
    installedFeature.scope,
    'install',
    undefined,
    true,
    installedFeature.attrs,
  );

  try {
    await integrationInstaller.removeFeature(context, featureDeclaration);
    return {
      status: 'removed',
      integrationStateId: installed.id,
      featureId: installedFeature.featureId,
      agentExtensionIds: collectAgentExtensionIds(
        state,
        installed.integrationId,
        installedFeature.targetRoot,
      ),
    };
  } catch (err) {
    return {
      status: 'failed',
      message: `${installed.integrationId}.${installedFeature.featureId}: ${(err as Error).message}`,
    };
  }
}

function collectAgentExtensionIds(
  state: CliState,
  integrationId: string,
  targetRoot: string,
): string[] {
  const agentId = INTEGRATION_TO_AGENT_ID[integrationId];
  if (!agentId) {
    return [];
  }

  return state.agentExtensions
    .filter((ext) => ext.agentId === agentId && ext.projectRoot === targetRoot)
    .map((ext) => ext.id);
}

function buildIntegrationPhaseItem(totalRemoved: number, failed: string[]): PhaseItem {
  if (failed.length > 0) {
    const counts =
      totalRemoved > 0
        ? `${totalRemoved} removed, ${failed.length} failed`
        : `${failed.length} failed`;
    return phaseItem('Integrations', 'warn', `${counts}: ${failed.join('; ')}`);
  }

  if (totalRemoved > 0) {
    const label = totalRemoved === 1 ? 'target' : 'targets';
    return phaseItem('Integrations', 'done', `Removed ${totalRemoved} integration ${label}.`);
  }

  return phaseItem('Integrations', 'info', 'Nothing to remove.');
}

async function removeLegacyAgentExtensions(
  state: CliState,
): Promise<{ cleanedIds: string[]; failed: string[] }> {
  const cleanedIds: string[] = [];
  const failed: string[] = [];

  for (const extension of state.agentExtensions) {
    try {
      await cleanupLegacyExtension(extension);
      cleanedIds.push(extension.id);
    } catch (err) {
      failed.push(`${extension.agentId}/${extension.name}: ${(err as Error).message}`);
    }
  }

  return { cleanedIds, failed };
}

async function cleanupLegacyExtension(extension: AgentExtension): Promise<void> {
  if (extension.kind === 'hook') {
    await cleanupLegacyHookExtension(extension);
    return;
  }

  if (extension.kind === 'instructions') {
    // Instructions are marker-based snippets; declarative remove handles new installs.
    // Legacy-only instructions have no stable on-disk path beyond agent-specific files.
    return;
  }

  const skillPath = join(extension.projectRoot, '.agents', 'skills', extension.name, 'SKILL.md');
  if (existsSync(skillPath)) {
    rmSync(skillPath, { force: true });
  }
}

async function cleanupLegacyHookExtension(extension: HookExtension): Promise<void> {
  if (extension.agentId === 'claude-code') {
    await cleanupClaudeLegacyHook(extension);
    return;
  }

  if (extension.agentId === 'copilot-cli') {
    await cleanupCopilotLegacyHook(extension);
  }
}

function claudeHookMarkers(extension: HookExtension): string[] {
  if (extension.name === 'sonar-sqaa') {
    return ['sonar-sqaa'];
  }
  if (extension.name === SONAR_SECRETS_MARKER) {
    return [SONAR_SECRETS_MARKER];
  }
  return [extension.name];
}

async function cleanupClaudeLegacyHook(extension: HookExtension): Promise<void> {
  const settingsPath = join(extension.projectRoot, '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    const document = await readOrInitJson(settingsPath, { hooks: {} });
    const updated = removeAgentHooks(document, claudeHookMarkers(extension));
    await writeFile(settingsPath, `${JSON.stringify(updated, null, 2)}\n`);
  }

  const hookDir = join(extension.projectRoot, '.claude', 'hooks', extension.name);
  if (existsSync(hookDir)) {
    rmSync(hookDir, { recursive: true, force: true });
  }
}

async function cleanupCopilotLegacyHook(extension: HookExtension): Promise<void> {
  const hooksJsonPath = extension.global
    ? join(homedir(), '.copilot', 'hooks', 'hooks.json')
    : join(extension.projectRoot, '.github', 'hooks', 'hooks.json');

  if (existsSync(hooksJsonPath)) {
    const raw = await readFile(hooksJsonPath, 'utf-8');
    const document = JSON.parse(raw) as unknown;
    const updated = removeCopilotHookConfig(document);
    await writeFile(hooksJsonPath, `${JSON.stringify(updated, null, 2)}\n`);
  }

  const scriptDir = extension.global
    ? join(homedir(), '.copilot', 'hooks', SONAR_SECRETS_MARKER)
    : join(extension.projectRoot, '.github', 'hooks', SONAR_SECRETS_MARKER);
  if (existsSync(scriptDir)) {
    rmSync(scriptDir, { recursive: true, force: true });
  }
}
