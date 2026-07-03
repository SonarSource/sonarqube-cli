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

import { confirmPrompt, discreetSuccess, info, text } from '../../../../../ui';
import { red } from '../../../../../ui/colors.js';
import { CommandFailedError } from '../../../_common/error';
import { findInstalledFeature } from './installation-recorder';
import type {
  FeatureApplication,
  FeatureContainer,
  FeatureDeclaration,
  FeatureSelectionResult,
  IntegrationDeclaration,
  IntegrationInvocation,
  SubfeatureDeclaration,
} from './types';

/**
 * Outcome of a feature's `shouldInstall` evaluation. Integrations declare the
 * intent; the installer resolves it (prompting / skip messaging) centrally.
 */
export type InstallDecision =
  | { action: 'install'; message?: string }
  | { action: 'skip'; message?: string }
  | { action: 'ask'; question?: string };

/** Install the feature without asking, optionally printing a message. */
export function install(message?: string): InstallDecision {
  return { action: 'install', message };
}

/** Skip the feature, optionally explaining why. */
export function skip(message?: string): InstallDecision {
  return { action: 'skip', message };
}

/** Ask the user whether to install the feature, with an optional custom prompt. */
export function askUser(question?: string): InstallDecision {
  return { action: 'ask', question };
}

/**
 * Coerce a `shouldInstall` result into an {@link InstallDecision}.
 *
 * A missing predicate defaults to asking the user (opt-in). An explicit `true`
 * installs without asking, `false` skips silently, and an explicit
 * {@link InstallDecision} passes through unchanged.
 */
export function normalizeDecision(result: boolean | InstallDecision | undefined): InstallDecision {
  if (result === undefined) {
    return askUser();
  }
  if (result === true) {
    return install();
  }
  if (result === false) {
    return skip();
  }
  return result;
}

/** Type guard — returns true when `feature` is a {@link FeatureContainer}. */
export function isFeatureContainer<TOptions>(
  feature: FeatureDeclaration<TOptions>,
): feature is FeatureContainer<TOptions> {
  return 'subfeatures' in feature;
}

/**
 * Interactive feature selection over the pre-resolved `applications`.
 */
export async function selectFeaturesForInvocation<TOptions>(
  integration: IntegrationDeclaration<TOptions>,
  invocation: IntegrationInvocation<TOptions>,
  applications: FeatureApplication<TOptions>[],
): Promise<FeatureSelectionResult<TOptions>> {
  const toInstall: FeatureApplication<TOptions>[] = [];
  const toRemove: FeatureApplication<TOptions>[] = [];

  for (const application of applications) {
    const feature = application.feature;
    if (isFeatureInstalled(integration, invocation, application)) {
      if (await shouldRemoveInstalledFeature(feature, invocation)) {
        toRemove.push(application);
      } else {
        toInstall.push(await materializeApplication(application, invocation));
      }
    } else if (await shouldInstallFeature(feature, invocation)) {
      toInstall.push(await materializeApplication(application, invocation));
    }
  }

  return { toInstall, toRemove };
}

function isFeatureInstalled<TOptions>(
  integration: IntegrationDeclaration<TOptions>,
  invocation: IntegrationInvocation<TOptions>,
  application: FeatureApplication<TOptions>,
): boolean {
  return (
    findInstalledFeature(invocation.state, application, integration, application.feature) !==
    undefined
  );
}

/**
 * Decide whether to uninstall an already-installed feature. Prompts `Keep?`
 * (default Yes); declining asks for a removal confirmation (default Yes).
 * Returns true only when the user confirms removal.
 */
async function shouldRemoveInstalledFeature<TOptions>(
  feature: FeatureDeclaration<TOptions>,
  invocation: IntegrationInvocation<TOptions>,
): Promise<boolean> {
  if (invocation.nonInteractive) {
    return false;
  }

  const keep = await confirmPrompt(`${feature.displayName} (currently installed)  Keep?`, true);
  if (keep === null) {
    throw new CommandFailedError('Installation cancelled');
  }
  if (keep) {
    return false;
  }

  warnFeatureRemoval(`${feature.displayName} will be removed.`);
  const proceed = await confirmPrompt('Proceed with removal?', true);
  if (proceed === null) {
    throw new CommandFailedError('Installation cancelled');
  }
  return proceed;
}

/**
 * One-off, local to the keep/remove flow — not a shared `prompts.ts` primitive.
 * The generic `error()` writes `❌ <msg>` to stderr at column 0 with a
 * double-width emoji, so it juts left of the clack prompts that bracket it
 * (`Keep?` / `Proceed with removal?`). We instead reproduce the prompt gutter:
 * `  <glyph>  <message>` on stdout, with a single-width `✗` (U+2717) —
 * the emoji is double-width and shifts the text a column.
 */
function warnFeatureRemoval(message: string): void {
  text(`  ${red('✗')}  ${message}`);
}

/**
 * For a container application, narrow its subfeatures to those whose
 * `shouldInstall` is active; non-container applications are returned unchanged.
 */
async function materializeApplication<TOptions>(
  application: FeatureApplication<TOptions>,
  invocation: IntegrationInvocation<TOptions>,
): Promise<FeatureApplication<TOptions>> {
  const feature = application.feature;
  if (!isFeatureContainer(feature)) {
    return application;
  }
  return { ...application, feature: await selectActiveSubfeatures(feature, invocation) };
}

async function selectActiveSubfeatures<TOptions>(
  container: FeatureContainer<TOptions>,
  invocation: IntegrationInvocation<TOptions>,
): Promise<FeatureContainer<TOptions>> {
  const active: SubfeatureDeclaration<TOptions>[] = [];
  for (const subfeature of container.subfeatures) {
    if (await shouldInstallFeature(subfeature, invocation)) {
      active.push(subfeature);
    }
  }
  return { ...container, subfeatures: active };
}

async function shouldInstallFeature<TOptions>(
  feature: FeatureDeclaration<TOptions>,
  invocation: IntegrationInvocation<TOptions>,
): Promise<boolean> {
  const decision = normalizeDecision(await feature.shouldInstall?.(invocation));
  switch (decision.action) {
    case 'install':
      if (decision.message) {
        discreetSuccess(decision.message);
      }
      return true;
    case 'skip':
      if (decision.message) {
        info(decision.message);
      }
      return false;
    case 'ask': {
      if (invocation.nonInteractive) {
        return true;
      }
      const defaultQuestion = feature.benefitDescription
        ? `Install ${feature.displayName}? (${feature.benefitDescription})`
        : `Install ${feature.displayName}?`;
      const confirmed = await confirmPrompt(decision.question ?? defaultQuestion, true);
      if (confirmed === null) {
        throw new CommandFailedError('Installation cancelled');
      }
      return confirmed;
    }
  }
}
