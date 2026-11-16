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
import {
  isUnavailable,
  type LinkedProjectIssue,
  reportLinkedProjectIssues,
} from './steps/linked-projects.ts';
import { projectDashboardUrl } from './steps/mapping.ts';

const NO_MONOREPO_ROOTS = [
  'No project root is mapped in .sonar-config.json, so nothing was changed.',
  "Name the roots with 'sonar init --monorepo --root <path>[=<project key>]'; repeat --root for each one.",
];
const MONOREPO_RESUME =
  "To resume, run 'sonar init --monorepo' again with the same --root options: roots that are already configured are left as they are.";

/** In display order; a root belongs to the section of its outcome, so a line does not repeat it. */
const MONOREPO_SECTIONS: { title: string; kinds: MonorepoRootResult['kind'][] }[] = [
  { title: 'Created and bound to the repository', kinds: ['bound'] },
  { title: 'Created', kinds: ['unbound'] },
  { title: 'Mapped to the existing project', kinds: ['linked'] },
  { title: 'Already configured', kinds: ['configured'] },
  // The warnings printed while checking the roots say why a root was left as it is.
  { title: 'Skipped', kinds: ['skipped', 'unavailable', 'conflict'] },
  { title: 'Failed', kinds: ['failed'] },
];

const UNAVAILABLE_REASONS = {
  missing: 'not found on the remote',
  'other-org': 'in another organization or not accessible',
  unverified: 'could not be checked',
} as const;

function describeMonorepo(
  roots: readonly MonorepoRootResult[],
  auth: ResolvedAuth | undefined,
): string[] {
  const lines = ['', 'Monorepo onboarding summary:'];
  for (const { title, kinds } of MONOREPO_SECTIONS) {
    const matching = roots.filter((root) => kinds.includes(root.kind));
    if (matching.length > 0) {
      lines.push(
        `  ${title} (${matching.length}):`,
        ...matching.map((root) => `    ${describeMonorepoRoot(root, auth)}`),
      );
    }
  }
  // A missing project or a conflicting key stays as it is until the file or the command changes.
  if (roots.some((root) => root.kind === 'skipped' || root.kind === 'failed')) {
    lines.push(MONOREPO_RESUME);
  }
  return lines;
}

/** The dashboard link sits on the root's own line, so the summary does not repeat each project. */
function describeMonorepoRoot(root: MonorepoRootResult, auth: ResolvedAuth | undefined): string {
  switch (root.kind) {
    case 'configured':
    case 'linked':
    case 'bound':
    case 'unbound': {
      const line = `${root.path}: ${root.projectKey}`;
      return auth ? `${line} - ${projectDashboardUrl(auth, root.projectKey)}` : line;
    }
    case 'skipped':
      return root.path;
    case 'unavailable':
      return `${root.path}: ${root.projectKey} (${UNAVAILABLE_REASONS[root.problem]})`;
    case 'conflict':
      return `${root.path}: ${root.projectKey} (already mapped to '${root.recordedKey}')`;
    case 'failed':
      return `${root.path}: ${root.reason.replaceAll('\n', '\n      ')}`;
  }
}

function describe(outcome: InitOutcome, auth: ResolvedAuth | undefined): string[] {
  switch (outcome.kind) {
    case 'complete': {
      const noun = outcome.projectKeys.length === 1 ? 'project' : 'projects';
      const keys = outcome.projectKeys.map((key) => `'${key}'`).join(', ');
      return [
        ...(outcome.projectKeys.length > 0
          ? [`This directory is already linked to the Sonar ${noun} ${keys} in .sonar-config.json.`]
          : []),
        ...(outcome.issues.some(isUnavailable) ? [] : ['Nothing left to set up.']),
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
      return describeMonorepo(outcome.roots, auth);
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
  for (const line of describe(outcome, auth)) {
    console.print(line);
  }
  if (auth) {
    reportLinkedProjectIssues(linkedProjectIssues(outcome), auth, console);
    renderProjectDashboards(outcome, auth, console);
  }
}

/** A monorepo reports its own problems when it finds them, before it onboards anything. */
function linkedProjectIssues(outcome: InitOutcome): readonly LinkedProjectIssue[] {
  return outcome.kind === 'complete' ? outcome.issues : [];
}

function mappedProjectKeys(outcome: InitOutcome): readonly string[] {
  switch (outcome.kind) {
    case 'complete':
      return outcome.projectKeys;
    case 'linked':
    case 'bound':
    case 'unbound':
      return [outcome.projectKey];
    case 'monorepo': // Each root's link is already on its summary line.
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
