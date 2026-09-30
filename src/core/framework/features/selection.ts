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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { red } from '@/core/ui/colors.ts';
import type { Console } from '@/core/ui/console.ts';

import { findInstalledFeature } from './installation-recorder.ts';
import type {
  FeatureApplication,
  FeatureContainer,
  FeatureDeclaration,
  FeatureSelectionResult,
  IntegrationDeclaration,
  IntegrationInvocation,
  SubfeatureDeclaration,
} from './types.ts';
import { isFeatureContainer } from './types.ts';

/**
 * Outcome of a feature's `shouldInstall` evaluation. Integrations declare the
 * intent; the installer resolves it (prompting / skip messaging) centrally.
 */
export type InstallDecision =
  | { action: 'install'; message?: string }
  | { action: 'skip'; message?: string }
  | { action: 'uninstall'; message?: string }
  | { action: 'ask'; question?: string };

/** Install the feature without asking, optionally printing a message. */
export function install(message?: string): InstallDecision {
  return { action: 'install', message };
}

/** Skip the feature, optionally explaining why. */
export function skip(message?: string): InstallDecision {
  return { action: 'skip', message };
}

/** Uninstall the feature without asking, optionally printing a message. */
export function uninstall(message?: string): InstallDecision {
  return { action: 'uninstall', message };
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

/**
 * Interactive feature selection over the pre-resolved `applications`.
 */
export async function selectFeaturesForInvocation<TOptions>(
  integration: IntegrationDeclaration<TOptions>,
  invocation: IntegrationInvocation<TOptions>,
  applications: FeatureApplication<TOptions>[],
  console: Console,
): Promise<FeatureSelectionResult<TOptions>> {
  const toInstall: FeatureApplication<TOptions>[] = [];
  const toRemove: FeatureApplication<TOptions>[] = [];
  const declined: string[] = [];

  const evaluations = evaluateApplications(
    integration,
    invocation,
    applications,
    declined,
    console,
  );
  for await (const { application, outcome, installed } of evaluations) {
    if (outcome === 'install') {
      toInstall.push(application);
    } else if (outcome === 'uninstall' && installed) {
      toRemove.push(application);
    } else if (outcome === 'declined') {
      declined.push(application.feature.id);
    }
  }

  return { toInstall, toRemove, declined };
}

interface ApplicationEvaluation<TOptions> {
  application: FeatureApplication<TOptions>;
  outcome: FeatureSelectionOutcome;
  installed: boolean;
}

/**
 * Evaluates applications one at a time: prompts are interactive and must not overlap.
 */
async function* evaluateApplications<TOptions>(
  integration: IntegrationDeclaration<TOptions>,
  invocation: IntegrationInvocation<TOptions>,
  applications: FeatureApplication<TOptions>[],
  declined: string[],
  console: Console,
): AsyncGenerator<ApplicationEvaluation<TOptions>> {
  for (const application of applications) {
    yield evaluateApplication(integration, invocation, application, declined, console);
  }
}

async function evaluateApplication<TOptions>(
  integration: IntegrationDeclaration<TOptions>,
  invocation: IntegrationInvocation<TOptions>,
  application: FeatureApplication<TOptions>,
  declined: string[],
  console: Console,
): Promise<ApplicationEvaluation<TOptions>> {
  const installed = isFeatureInstalled(integration, invocation, application);
  const outcome = await shouldInstallFeature(application.feature, invocation, console, installed);
  if (outcome !== 'install') {
    return { application, outcome, installed };
  }
  const materialized = await materializeApplication(application, invocation, declined, console);
  return { application: materialized, outcome, installed };
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
  console: Console,
): Promise<boolean> {
  if (invocation.nonInteractive) {
    return false;
  }

  const keep = await console.confirmPrompt(
    `${feature.displayName} (currently installed)  Keep?`,
    true,
  );
  if (keep === null) {
    throw new CommandFailedError('Installation cancelled');
  }
  if (keep) {
    return false;
  }

  warnFeatureRemoval(console, `${feature.displayName} will be removed.`);
  const proceed = await console.confirmPrompt('Proceed with removal?', true);
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
function warnFeatureRemoval(console: Console, message: string): void {
  console.text(`  ${red('✗')}  ${message}`);
}

type FeatureSelectionOutcome = 'install' | 'skip' | 'uninstall' | 'declined';

/**
 * For a container application, narrow its subfeatures to those whose
 * `shouldInstall` is active; non-container applications are returned unchanged.
 * Declined subfeature ids are appended to `declined`.
 */
async function materializeApplication<TOptions>(
  application: FeatureApplication<TOptions>,
  invocation: IntegrationInvocation<TOptions>,
  declined: string[],
  console: Console,
): Promise<FeatureApplication<TOptions>> {
  const feature = application.feature;
  if (!isFeatureContainer(feature)) {
    return application;
  }
  return {
    ...application,
    feature: await selectActiveSubfeatures(feature, invocation, declined, console),
  };
}

async function selectActiveSubfeatures<TOptions>(
  container: FeatureContainer<TOptions>,
  invocation: IntegrationInvocation<TOptions>,
  declined: string[],
  console: Console,
): Promise<FeatureContainer<TOptions>> {
  const active: SubfeatureDeclaration<TOptions>[] = [];
  // Chain decisions so interactive prompts stay sequential and ordered.
  await container.subfeatures.reduce(async (previous, subfeature) => {
    await previous;
    const outcome = await shouldInstallFeature(subfeature, invocation, console);
    if (outcome === 'install') {
      active.push(subfeature);
    } else if (outcome === 'declined') {
      declined.push(subfeature.id);
    }
  }, Promise.resolve());
  return { ...container, subfeatures: active };
}

async function shouldInstallFeature<TOptions>(
  feature: FeatureDeclaration<TOptions>,
  invocation: IntegrationInvocation<TOptions>,
  console: Console,
  installed = false,
): Promise<FeatureSelectionOutcome> {
  const decision = normalizeDecision(await feature.shouldInstall?.(invocation));
  if (decision.action === 'ask') {
    return resolveAskDecision(feature, invocation, decision.question, installed, console);
  }
  displayDecisionMessage(console, decision.action, decision.message, installed);
  return decision.action;
}

function displayDecisionMessage(
  console: Console,
  action: 'install' | 'skip' | 'uninstall',
  message: string | undefined,
  installed: boolean,
): void {
  if (!message || (action === 'uninstall' && !installed)) {
    return;
  }
  if (action === 'install') {
    console.discreetSuccess(message);
  } else {
    console.info(message);
  }
}

async function resolveAskDecision<TOptions>(
  feature: FeatureDeclaration<TOptions>,
  invocation: IntegrationInvocation<TOptions>,
  question: string | undefined,
  installed: boolean,
  console: Console,
): Promise<FeatureSelectionOutcome> {
  if (installed) {
    return (await shouldRemoveInstalledFeature(feature, invocation, console))
      ? 'uninstall'
      : 'install';
  }
  if (invocation.nonInteractive) {
    return 'install';
  }
  const defaultQuestion = feature.benefitDescription
    ? `Install ${feature.displayName}? (${feature.benefitDescription})`
    : `Install ${feature.displayName}?`;
  const confirmed = await console.confirmPrompt(question ?? defaultQuestion, true);
  if (confirmed === null) {
    throw new CommandFailedError('Installation cancelled');
  }
  return confirmed ? 'install' : 'declined';
}
