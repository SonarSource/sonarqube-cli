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

import type {
  FeatureApplication,
  FeatureDeclaration,
  FeatureSelectionResult,
  SubfeatureApplication,
} from './types.ts';

export function reportFeatureAvailability<TOptions>(
  applications: FeatureApplication<TOptions>[],
  console: Console,
): void {
  for (const application of applications) {
    reportAvailability(application.feature.displayName, application, console);
    if (application.available !== true) {
      continue;
    }
    for (const subfeatureApplication of application.subfeatureApplications) {
      reportAvailability(
        subfeatureApplication.subfeature.displayName,
        subfeatureApplication,
        console,
      );
    }
  }
}

function reportAvailability(
  displayName: string,
  item: Pick<FeatureApplication, 'installed' | 'available' | 'unavailableReason'>,
  console: Console,
): void {
  if (item.available === undefined) {
    console.warn(`Could not check whether ${displayName} is available.`);
    return;
  }
  if (item.available) {
    return;
  }
  if (item.unavailableReason) {
    console.info(item.unavailableReason);
  }
  if (item.installed) {
    console.info(`${displayName} is no longer available. Removing it.`);
  }
}

/**
 * Decide which applications to install or remove from their availability and
 * install state, prompting per feature unless `useRecommended`. Reporting is
 * done separately by {@link reportFeatureAvailability}.
 */
export async function resolveFeatureSelection<TOptions>(
  applications: FeatureApplication<TOptions>[],
  useRecommended: boolean,
  console: Console,
): Promise<FeatureSelectionResult<TOptions>> {
  const toInstall: FeatureApplication<TOptions>[] = [];
  const toRemove: FeatureApplication<TOptions>[] = [];
  const declined: string[] = [];

  for (const application of applications) {
    const { feature } = application;
    if (application.available === undefined) {
      continue;
    }
    if (!application.available) {
      if (application.installed) {
        toRemove.push(application);
      }
      continue;
    }

    const action = await resolveAvailableFeatureAction(
      feature,
      application.installed,
      useRecommended,
      console,
    );
    if (action === 'install') {
      toInstall.push(
        await resolveSubfeatureSelection(application, useRecommended, declined, console),
      );
    } else if (action === 'uninstall') {
      toRemove.push(application);
    } else {
      declined.push(feature.id);
    }
  }

  return { toInstall, toRemove, declined };
}

async function resolveSubfeatureSelection<TOptions>(
  application: FeatureApplication<TOptions>,
  useRecommended: boolean,
  declined: string[],
  console: Console,
): Promise<FeatureApplication<TOptions>> {
  const subfeatureApplications: SubfeatureApplication<TOptions>[] = [];
  for (const subfeatureApplication of application.subfeatureApplications) {
    const { subfeature } = subfeatureApplication;
    let active: boolean;
    if (subfeatureApplication.available === undefined) {
      active = subfeatureApplication.installed;
    } else if (!subfeatureApplication.available) {
      active = false;
    } else {
      active =
        subfeature.required === true ||
        useRecommended ||
        (await confirmInstall(subfeature, console));
      if (!active) {
        declined.push(subfeature.id);
      }
    }
    subfeatureApplications.push({ ...subfeatureApplication, active });
  }
  return { ...application, subfeatureApplications };
}

type AvailableFeatureAction = 'install' | 'uninstall' | 'declined';

async function resolveAvailableFeatureAction<TOptions>(
  feature: FeatureDeclaration<TOptions>,
  installed: boolean,
  useRecommended: boolean,
  console: Console,
): Promise<AvailableFeatureAction> {
  if (feature.required || useRecommended) {
    return 'install';
  }
  if (installed) {
    return (await shouldRemoveInstalledFeature(feature, console)) ? 'uninstall' : 'install';
  }
  return (await confirmInstall(feature, console)) ? 'install' : 'declined';
}

async function confirmInstall(
  feature: Pick<FeatureDeclaration, 'displayName' | 'benefitDescription'>,
  console: Console,
): Promise<boolean> {
  const question = feature.benefitDescription
    ? `Install ${feature.displayName}? (${feature.benefitDescription})`
    : `Install ${feature.displayName}?`;
  const confirmed = await console.confirmPrompt(question, true);
  if (confirmed === null) {
    throw new CommandFailedError('Installation cancelled');
  }
  return confirmed;
}

/**
 * Decide whether to uninstall an already-installed feature. Prompts `Keep?`
 * (default Yes); declining asks for a removal confirmation (default Yes).
 * Returns true only when the user confirms removal.
 */
async function shouldRemoveInstalledFeature<TOptions>(
  feature: FeatureDeclaration<TOptions>,
  console: Console,
): Promise<boolean> {
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
