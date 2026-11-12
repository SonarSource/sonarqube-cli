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
import type { Console } from '@/core/ui/console.ts';

import type { InitOutcome, MonorepoRootResult } from './init-outcome.ts';
import { projectDashboardUrl } from './steps/mapping.ts';

const NO_MONOREPO_ROOTS = [
  'No project root is mapped in .sonar-config.json, so nothing was changed.',
  "Map each root with 'sonar link --monorepo' (add --path to name its directory), then run 'sonar init --monorepo' again.",
];
const MONOREPO_RESUME =
  "To resume, run 'sonar init --monorepo' again: roots that are already configured are left as they are.";

/** A root that ended up mapped to a project, whichever path got it there. */
function isMappedRoot(
  root: MonorepoRootResult,
): root is Extract<MonorepoRootResult, { projectKey: string }> {
  return 'projectKey' in root;
}

function describeMonorepo(roots: readonly MonorepoRootResult[]): string[] {
  const lines = ['Monorepo onboarding summary:'];
  const sections: { title: string; includes: (root: MonorepoRootResult) => boolean }[] = [
    { title: 'Configured', includes: isMappedRoot },
    { title: 'Skipped', includes: (root) => root.kind === 'skipped' },
    { title: 'Failed', includes: (root) => root.kind === 'failed' },
  ];
  for (const { title, includes } of sections) {
    const matching = roots.filter(includes);
    if (matching.length > 0) {
      lines.push(
        `  ${title} (${matching.length}):`,
        ...matching.map((root) => `    ${describeMonorepoRoot(root)}`),
      );
    }
  }
  if (roots.some((root) => root.kind === 'skipped' || root.kind === 'failed')) {
    lines.push(MONOREPO_RESUME);
  }
  return lines;
}

function describeMonorepoRoot(root: MonorepoRootResult): string {
  switch (root.kind) {
    case 'configured':
      return `${root.path}: ${root.projectKey} (already configured)`;
    case 'linked':
      return `${root.path}: ${root.projectKey} (mapped to the existing project)`;
    case 'bound':
      return `${root.path}: ${root.projectKey} (created and bound to the repository)`;
    case 'unbound':
      return `${root.path}: ${root.projectKey} (created)`;
    case 'skipped':
      return root.path;
    case 'failed':
      return `${root.path}: ${root.reason.replaceAll('\n', '\n      ')}`;
  }
}

function describe(outcome: InitOutcome): string[] {
  switch (outcome.kind) {
    case 'complete': {
      const noun = outcome.projectKeys.length === 1 ? 'project' : 'projects';
      const keys = outcome.projectKeys.map((key) => `'${key}'`).join(', ');
      return [
        `This directory is already linked to the Sonar ${noun} ${keys} in .sonar-config.json.`,
        'Nothing left to set up.',
      ];
    }
    case 'linked':
    case 'bound':
    case 'unbound':
      return [];
    case 'declined':
      return ['No project was created.'];
    case 'no-organization':
      return ['No organization was created.'];
    case 'monorepo':
      return describeMonorepo(outcome.roots);
    case 'no-monorepo-roots':
      return NO_MONOREPO_ROOTS;
  }
}

/** Prints what the run did, then the project dashboard link. The integrate offer follows it. */
export function renderInitOutcome(
  outcome: InitOutcome,
  auth: ResolvedAuth | undefined,
  console: Console,
): void {
  for (const line of describe(outcome)) {
    console.print(line);
  }
  if (auth) {
    renderProjectDashboards(outcome, auth, console);
  }
}

function mappedProjectKeys(outcome: InitOutcome): readonly string[] {
  switch (outcome.kind) {
    case 'complete':
      return outcome.projectKeys;
    case 'linked':
    case 'bound':
    case 'unbound':
      return [outcome.projectKey];
    case 'monorepo':
      return outcome.roots.filter(isMappedRoot).map((root) => root.projectKey);
    case 'declined':
    case 'no-organization':
    case 'no-monorepo-roots':
      return [];
  }
}

/**
 * Printed once per successful run, whichever path it took, and by no step. A run that left no
 * project mapped (declined, or not run yet) prints nothing.
 */
export function renderProjectDashboards(
  outcome: InitOutcome,
  auth: ResolvedAuth,
  console: Console,
): void {
  const keys = mappedProjectKeys(outcome);
  for (const key of keys) {
    const label = keys.length === 1 ? 'Project dashboard' : `Project dashboard (${key})`;
    console.print(`${label}: ${projectDashboardUrl(auth, key)}`);
  }
}
