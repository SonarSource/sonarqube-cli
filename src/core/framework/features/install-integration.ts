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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { findGitRoot } from '@/core/host/git/discover.ts';
import logger from '@/core/observability/logger.ts';
import type {
  CliState,
  InstalledIntegrationFeature,
  IntegrationScope,
  IntegrationStateAttribute,
} from '@/core/state/state.ts';
import { loadState, saveStateKeepingInstalledDependencies } from '@/core/state/state-repository.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import type { Console } from '@/core/ui/console.ts';

import { renderCompletionSummary } from './completion-summary.ts';
import { buildApplications } from './feature-target.ts';
import {
  promptInstallConfirmation,
  promptUseRecommended,
  renderInstallPreview,
} from './install-preview.ts';
import { integrationInstaller } from './installer.ts';
import type { IntegrationRegistry } from './registry.ts';
import {
  customizeFeatureSelection,
  hasCustomizableChoices,
  reportFeatureAvailability,
  resolveRecommendedFeatures,
} from './selection.ts';
import type {
  FeatureSelectionResult,
  IntegrationContext,
  IntegrationDeclaration,
  IntegrationExecutionMode,
  IntegrationInvocation,
} from './types.ts';

/** Facts from a successful install; commands turn these into telemetry. */
export interface InstallIntegrationSuccessFacts {
  installedFeatures: InstalledIntegrationFeature[];
  featuresDeclined: string[];
  featuresUninstalled: string[];
  repoRoot: string | null;
}

export interface InstallIntegrationOptions<TOptions> {
  registry: IntegrationRegistry;
  integrationId: string;
  options: TOptions;
  targetRoot: string;
  scope: IntegrationScope;
  console: Console;
  auth?: ResolvedAuth;
  force?: boolean;
  attrs?: Record<string, IntegrationStateAttribute>;
  nonInteractive?: boolean;
  excludedFeatureIds?: string[];
  /** Called after state is saved; omitted when the save fails. Awaited so emit finishes before the command returns. */
  onSuccess?: (facts: InstallIntegrationSuccessFacts) => void | Promise<void>;
}

export async function installIntegration<TOptions>({
  registry,
  integrationId,
  options,
  targetRoot,
  scope,
  console,
  auth,
  force,
  attrs,
  nonInteractive,
  excludedFeatureIds,
  onSuccess,
}: InstallIntegrationOptions<TOptions>): Promise<InstalledIntegrationFeature[]> {
  const integration = getIntegrationDeclaration<TOptions>(registry, integrationId);
  const state = loadState();
  const invocation: IntegrationInvocation<TOptions> = {
    options,
    targetRoot,
    scope,
    auth,
    force,
    attrs,
    nonInteractive,
    state,
  };
  const applications = await buildApplications(invocation, integration, excludedFeatureIds);
  reportFeatureAvailability(applications, console);
  const recommended = resolveRecommendedFeatures(applications);
  assertFeaturesSelected(recommended, integration.displayName);

  renderInstallPreview(recommended.toInstall, console);
  console.text('');
  const featureSelection = await confirmFeatureSelection(
    recommended,
    integration.displayName,
    nonInteractive,
    console,
  );
  console.text('');

  try {
    const installedFeatures = await integrationInstaller.applyAndRecordFeatures(
      state,
      integration,
      featureSelection.toInstall,
      {
        callbacks: {
          onFeatureApplyStart: (application) => {
            console.text(`     Installing ${application.feature.displayName}...`);
            for (const { subfeature, active } of application.subfeatureApplications) {
              if (active) {
                console.text(`       - ${subfeature.displayName}`);
              }
            }
          },
          onDependencySkipped: (dependency) => {
            console.text(`     ${dependency.displayName ?? dependency.id} already installed`);
          },
          onResourceSkipped: (resource) => {
            console.text(`     ${resource.displayName ?? resource.id} already installed`);
          },
        },
        executionMode: 'install',
        console,
      },
    );

    const removedFeatures = await integrationInstaller.removeAndRecordFeatures(
      state,
      integration,
      featureSelection.toRemove,
      {
        callbacks: {
          onFeatureRemoveStart: (feature) => {
            console.text(`     Removing ${feature.displayName}...`);
          },
        },
        console,
      },
    );

    renderCompletionSummary(integration, installedFeatures, removedFeatures, console);

    // Publish the project for command-executed telemetry. Project scope only:
    // `--global` installs have no project key recorded, which is why they report null.
    if (scope === 'project' && auth) {
      noteProject(auth, projectKeyFromAttrs(attrs));
    }

    const stateSaved = saveInstalledFeatures(state, console);
    if (stateSaved) {
      await onSuccess?.({
        installedFeatures,
        featuresDeclined: featureSelection.declined,
        featuresUninstalled: featureSelection.toRemove.map((application) => application.feature.id),
        repoRoot: resolveRepoRootForScope(scope, targetRoot),
      });
    }

    return stateSaved ? installedFeatures : [];
  } catch (error) {
    saveInstalledFeatures(state, console);
    throw error;
  }
}

function assertFeaturesSelected<TOptions>(
  selection: FeatureSelectionResult<TOptions>,
  displayName: string,
): void {
  if (selection.toInstall.length === 0 && selection.toRemove.length === 0) {
    throw new CommandFailedError(`No feature selected for ${displayName}`);
  }
}

async function confirmFeatureSelection<TOptions>(
  recommended: FeatureSelectionResult<TOptions>,
  displayName: string,
  nonInteractive: boolean | undefined,
  console: Console,
): Promise<FeatureSelectionResult<TOptions>> {
  if (nonInteractive === true || recommended.toInstall.length === 0) {
    return recommended;
  }
  if (!hasCustomizableChoices(recommended.toInstall)) {
    await promptInstallConfirmation(console);
    return recommended;
  }
  if (await promptUseRecommended(console)) {
    return recommended;
  }
  const customized = await customizeFeatureSelection(recommended, console);
  assertFeaturesSelected(customized, displayName);
  if (customized.toInstall.length > 0) {
    console.text('');
    renderInstallPreview(customized.toInstall, console);
    await promptInstallConfirmation(console);
  }
  return customized;
}

export function makeContext(
  state: CliState,
  targetRoot: string,
  scope: IntegrationScope,
  executionMode: IntegrationExecutionMode,
  auth: ResolvedAuth | undefined,
  force: boolean | undefined,
  attrs: Record<string, IntegrationStateAttribute> | undefined,
  console: Console,
): IntegrationContext {
  return {
    state,
    targetRoot,
    scope,
    executionMode,
    console,
    auth,
    force,
    attrs,
    resolvedDependencies: new Map(),
  };
}

/**
 * Project key for telemetry `project_uuid`. Read from the invocation attrs rather than the
 * installed features — every application inherits these verbatim, so the value is the same,
 * but it also survives a run that only removes features. The non-empty check is what makes a
 * secrets-only `integrate git` (which records an explicit `null`) report no project.
 */
function projectKeyFromAttrs(
  attrs: Record<string, IntegrationStateAttribute> | undefined,
): string | undefined {
  const value = attrs?.projectKey;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Repo root for telemetry `repo_id`: the git root for
 * project-scope installs, or null for global scope / non-git targets.
 */
function resolveRepoRootForScope(scope: IntegrationScope, targetRoot: string): string | null {
  if (scope === 'global') return null;
  const { gitRoot, isGit } = findGitRoot(targetRoot);
  return isGit ? gitRoot : null;
}

function saveInstalledFeatures(state: CliState, console: Console): boolean {
  try {
    saveStateKeepingInstalledDependencies(state);
    return true;
  } catch (err) {
    const msg = (err as Error).message;
    console.warn(`Failed to update configuration state: ${msg}`);
    logger.warn(`Failed to update configuration state: ${msg}`);
    return false;
  }
}

function getIntegrationDeclaration<TOptions>(
  registry: IntegrationRegistry,
  integrationId: string,
): IntegrationDeclaration<TOptions> {
  const integration = registry.get(integrationId);
  if (!integration) {
    throw new CommandFailedError(`Integration declaration is not registered: ${integrationId}`);
  }
  return integration as IntegrationDeclaration<TOptions>;
}
