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

// Framework-rendered completion summary shared by every `sonar integrate`
// command: a borderless "Installed" list (each feature with the resource paths
// it edited), a "Setup complete!" outro, and the per-feature "try it out"
// examples. This keeps the wording and layout consistent across all
// integrations.

import { homedir } from 'node:os';
import { sep } from 'node:path';

import { info, note, outro, phase, phaseItem, text } from '@/core/ui';

import type { InstalledIntegrationFeature } from '../../../../lib/state.ts';
import type { FeatureDeclaration, IntegrationDeclaration, PostInstallExample } from './types.ts';

export function renderCompletionSummary<TOptions>(
  integration: IntegrationDeclaration<TOptions>,
  installedFeatures: InstalledIntegrationFeature[],
  removedFeatures: FeatureDeclaration<TOptions>[],
): void {
  if (installedFeatures.length === 0 && removedFeatures.length === 0) {
    return;
  }

  if (installedFeatures.length > 0) {
    renderInstalledList(integration, installedFeatures);
  }
  if (removedFeatures.length > 0) {
    renderRemovedList(removedFeatures);
  }
  outro('Setup complete!', 'success');
  renderPostInstallExamples(integration, installedFeatures);
}

function renderRemovedList<TOptions>(removedFeatures: FeatureDeclaration<TOptions>[]): void {
  const items = removedFeatures.map((feature) => phaseItem(feature.displayName, 'done'));
  phase('Removed', items);
}

function renderInstalledList<TOptions>(
  integration: IntegrationDeclaration<TOptions>,
  installedFeatures: InstalledIntegrationFeature[],
): void {
  const home = homedir();
  const items = installedFeatures.map((installed) => {
    const declaration = featureDeclaration(integration, installed.featureId);
    const paths = installed.resources
      .map((resource) => resource.path)
      .filter((path): path is string => Boolean(path))
      .map((p) => formatPath(p, home));
    return phaseItem(declaration.displayName, 'done', undefined, paths);
  });
  phase('Installed', items);
}

function formatPath(path: string, home: string): string {
  if (path === home) return '~';
  return path.startsWith(home + sep) ? '~' + path.slice(home.length) : path;
}

function renderPostInstallExamples<TOptions>(
  integration: IntegrationDeclaration<TOptions>,
  installedFeatures: InstalledIntegrationFeature[],
): void {
  // An integration may collapse its per-feature examples into a single combined
  // one when a specific set of features is installed together (e.g. both git
  // hooks). When it declines (returns undefined), fall back to per-feature.
  const combined = integration.combinedPostInstallExample?.(
    installedFeatures.map((f) => f.featureId),
  );
  if (combined) {
    renderPostInstallExample(combined);
    return;
  }
  for (const installed of installedFeatures) {
    const { postInstallExample } = featureDeclaration(integration, installed.featureId);
    if (postInstallExample) {
      renderPostInstallExample(postInstallExample);
    }
  }
}

function renderPostInstallExample(example: PostInstallExample): void {
  if (example.intro) {
    info(example.intro);
  }
  note(example.lines.join('\n'), example.title);
  if (example.footer) {
    text(example.footer);
  }
}

function featureDeclaration<TOptions>(
  integration: IntegrationDeclaration<TOptions>,
  featureId: string,
): FeatureDeclaration<TOptions> {
  const declaration = integration.features.find((feature) => feature.id === featureId);
  if (!declaration) {
    // Installed features always derive from the integration declaration, so a
    // missing match means the recorded state and the declaration are out of sync.
    throw new Error(`No declaration found for installed feature ${integration.id}.${featureId}`);
  }
  return declaration;
}
