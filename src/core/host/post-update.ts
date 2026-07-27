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

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  type FeatureDeclaration,
  findInstalledIntegration,
  integrationInstaller,
  type IntegrationRegistry,
  isFeatureContainer,
} from '@/core/framework/features';
import { installScaScannerBinary } from '@/core/host/install/sca-scanner.ts';
import { installSecretsBinary } from '@/core/host/install/secrets.ts';
import { appendTelemetryEvent } from '@/core/telemetry/telemetry-events.ts';

import { version as CURRENT_VERSION } from '../../../package.json';
import { getTelemetryDir } from '../config-constants.ts';
import logger from '../observability/logger.ts';
import type { CliState, HookExtension, InstalledIntegrationFeature } from '../state/state.ts';
import { loadState, saveState, stateFileExists, tryLoadState } from '../state/state-repository.ts';
import { isNewerVersion } from '../version.ts';
import { SCA_SCANNER_BINARY_NAME, SECRETS_BINARY_NAME } from './install-types.ts';
import {
  cleanObsoleteFromState,
  migrateHookScripts,
  OBSOLETE_A3S_MARKER,
  removeObsoleteHookArtifacts,
} from './migration.ts';

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
  installHooks: (
    projectRoot: string,
    globalDir: string | undefined,
    installSqaa: boolean,
  ) => Promise<void>;
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
    cleanObsoleteFromState(state, OBSOLETE_A3S_MARKER);
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

/** Migrates legacy telemetry events to the new pipeline (telemetry-events.ndjson). */
export function migrateLegacyTelemetryEvents(): void {
  migrateSinkFile();
  migrateStateQueue();
}

/** Moves any events left in `state.telemetry.events` to `telemetry-events.ndjson`. */
function migrateStateQueue(): void {
  const state = loadState();
  const legacyEvents = state.telemetry.events ?? [];
  if (legacyEvents.length === 0) {
    return;
  }

  // Clear the queue first, then drain: a crash mid-way loses a rare
  // best-effort event instead of re-appending duplicates on the next launch.
  delete state.telemetry.events;
  saveState(state);

  for (const event of legacyEvents) {
    appendTelemetryEvent(event);
  }

  logger.debug(
    `Migrated ${legacyEvents.length} legacy telemetry event(s) to telemetry-events.ndjson`,
  );
}

/** Migrates the previous telemetry file `findings.ndjson` to `telemetry-events.ndjson`. */
function migrateSinkFile(): void {
  const telemetryDir = getTelemetryDir();
  const oldPath = join(telemetryDir, 'findings.ndjson');
  const newPath = join(telemetryDir, 'telemetry-events.ndjson');
  if (!fs.existsSync(oldPath)) {
    return;
  }

  try {
    if (fs.existsSync(newPath)) {
      // Remove the old sink first, then append: a crash mid-way loses a rare
      // best-effort event instead of re-appending duplicates on the next launch.
      const oldContents = fs.readFileSync(oldPath, 'utf-8');
      fs.rmSync(oldPath);
      fs.appendFileSync(newPath, oldContents);
    } else {
      fs.renameSync(oldPath, newPath);
    }
    logger.debug('Migrated telemetry file findings.ndjson to telemetry-events.ndjson');
  } catch (error) {
    logger.debug(`Failed to migrate telemetry sink file: ${(error as Error).message}`);
  }
}

export async function migrateDeclarativeIntegrations(registry: IntegrationRegistry): Promise<void> {
  const state = loadState();
  let stateChanged = false;

  for (const integration of registry.list()) {
    const installedIntegration = findInstalledIntegration(state, integration);
    if (!installedIntegration) {
      continue;
    }

    const featuresById = new Map(integration.features.map((feature) => [feature.id, feature]));
    const knownFeatures = installedIntegration.features.filter((feature) =>
      featuresById.has(feature.featureId),
    );

    if (knownFeatures.length !== installedIntegration.features.length) {
      installedIntegration.features = knownFeatures;
      stateChanged = true;
    }

    const applications = [];
    for (const installedFeature of knownFeatures) {
      const feature = getFeature(featuresById, installedFeature);
      if (!feature) {
        continue;
      }

      if (installedFeature.scope === 'project' && !fs.existsSync(installedFeature.targetRoot)) {
        logger.debug(
          `Declarative migration skipped for ${integration.id}.${installedFeature.featureId}: target root no longer exists: ${installedFeature.targetRoot}`,
        );
        continue;
      }

      applications.push({
        feature: feature,
        targetRoot: installedFeature.targetRoot,
        scope: installedFeature.scope,
        attrs: installedFeature.attrs,
      });
    }

    try {
      const installedFeatures = await integrationInstaller.applyAndRecordFeatures(
        state,
        integration,
        applications,
        {
          continueOnFeatureError: true,
          executionMode: 'update',
          onFeatureError: (application, err) => {
            logger.debug(
              `Declarative migration failed for ${integration.id}.${application.feature.id}: ${err.message}`,
            );
          },
        },
      );
      if (installedFeatures.length > 0) {
        stateChanged = true;
      }
    } catch (err) {
      logger.debug(`Declarative migration failed for ${integration.id}: ${(err as Error).message}`);
    }
  }

  if (stateChanged) {
    saveState(state);
  }
}

function getFeature(
  featuresById: Map<string, FeatureDeclaration>,
  installedFeature: InstalledIntegrationFeature,
): FeatureDeclaration | undefined {
  const feature = featuresById.get(installedFeature.featureId);
  if (!feature) {
    return undefined;
  }

  let applicationFeature = feature;
  if (isFeatureContainer(feature)) {
    const activeIds = new Set(
      installedFeature.subfeatures !== undefined
        ? installedFeature.subfeatures.map((s) => s.featureId)
        : feature.defaultInstallSubfeatureIds,
    );
    const filteredContainer = {
      ...feature,
      subfeatures: feature.subfeatures.filter((s) => activeIds.has(s.id)),
    };
    applicationFeature = filteredContainer;
  }
  return applicationFeature;
}

/**
 * Update the sonar-secrets binary if it is already installed but targets a different version
 * than the one bundled with this CLI release.
 */
export async function updateSecretsBinaryIfNeeded(): Promise<void> {
  const state = loadState();

  if (!hasPreviousSecretsInstallation(state)) {
    logger.debug('sonar-secrets not installed — skipping binary update');
    return;
  }

  await installSecretsBinary();
}

function hasPreviousSecretsInstallation(state: CliState): boolean {
  return hasBinaryInState(state, SECRETS_BINARY_NAME);
}

/**
 * Update the sca-scanner-cli binary if it is already installed but targets a different version
 * than the one bundled with this CLI release.
 */
export async function updateScaScannerBinaryIfNeeded(): Promise<void> {
  const state = loadState();

  if (!hasBinaryInState(state, SCA_SCANNER_BINARY_NAME)) {
    logger.debug('sca-scanner-cli not installed — skipping binary update');
    return;
  }

  await installScaScannerBinary();
}

function hasBinaryInState(state: CliState, binaryName: string): boolean {
  return (state.tools?.installed ?? []).some((t) => t.name === binaryName);
}

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
  installHooksFn: PostUpdateDependencies['installHooks'],
  claudeIntegrationId: string,
  homedirFn: () => string = homedir,
): Promise<void> {
  const state = loadState();

  if (hasInstalledDeclarativeIntegration(state, claudeIntegrationId)) {
    logger.debug('Declarative Claude Code integration detected — skipping legacy hook migration');
    return;
  }

  type Location = { projectRoot: string; globalDir: string | undefined };
  const locations: Location[] = [];

  const extensions = state.agentExtensions.filter(
    (e): e is HookExtension => e.agentId === 'claude-code' && e.kind === 'hook',
  );

  if (extensions.length > 0) {
    // New format: use registry entries, deduplicate by (projectRoot, globalDir)
    const seen = new Set<string>();
    for (const ext of extensions) {
      const globalDir = ext.global ? homedirFn() : undefined;
      const key = `${ext.projectRoot}|${globalDir ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push({ projectRoot: ext.projectRoot, globalDir });
    }
  } else if (state.agents['claude-code'].configured) {
    // Pre-registry fallback: check for global hooks in homedir
    const globalHooksDir = join(homedirFn(), '.claude', 'hooks', 'sonar-secrets');
    if (fs.existsSync(globalHooksDir)) {
      locations.push({ projectRoot: homedirFn(), globalDir: homedirFn() });
    }
  }

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

function hasInstalledDeclarativeIntegration(state: CliState, integrationId: string): boolean {
  return state.integrations.installed.some(
    (entry) => entry.integrationId === integrationId && entry.features.length > 0,
  );
}
