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
import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import type { Console } from '@/core/ui/console.ts';

import type { DryRunAction, InitOutcome, MonorepoRootResult } from './init-outcome.ts';
import {
  isUnavailable,
  type LinkedProjectIssue,
  reportLinkedProjectIssues,
} from './steps/linked-projects.ts';
import { dashboardUrlOn, projectDashboardUrl } from './steps/mapping.ts';

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
  { title: 'Would be created', kinds: ['would-create'] },
  { title: 'Would be mapped to the existing project', kinds: ['would-link'] },
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
  dryRun: boolean,
): string[] {
  const lines = ['', dryRun ? 'Monorepo onboarding preview:' : 'Monorepo onboarding summary:'];
  for (const { title, kinds } of MONOREPO_SECTIONS) {
    const matching = roots.filter((root) => kinds.includes(root.kind));
    if (matching.length > 0) {
      // A real run would fail on these roots too, which a plain "Failed" would not say of a preview.
      const heading = dryRun && title === 'Failed' ? 'Would fail' : title;
      lines.push(
        `  ${heading} (${matching.length}):`,
        ...matching.map((root) => `    ${describeMonorepoRoot(root, auth)}`),
      );
    }
  }
  // A dry run ran nothing, so there is nothing to resume: the closing line says how to apply it.
  // A missing project or a conflicting key stays as it is until the file or the command changes.
  if (!dryRun && roots.some((root) => root.kind === 'skipped' || root.kind === 'failed')) {
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
      // A configured root may be recorded for another server than the active one.
      if (root.serverUrl) {
        return `${line} - ${dashboardUrlOn(root.serverUrl, root.projectKey)}`;
      }
      return auth ? `${line} - ${projectDashboardUrl(auth, root.projectKey)}` : line;
    }
    case 'would-link':
    case 'would-create':
      return `${root.path}: ${root.projectKey}`;
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

function describeDryRun(action: DryRunAction): string[] {
  switch (action.type) {
    case 'link':
      return [
        `Would link this directory to the existing project '${action.projectKey}' in ${SHARED_PROJECT_CONFIG_FILE_NAME}.`,
      ];
    case 'create':
      return [
        `Would create the project '${action.projectName}' (key '${action.projectKey}', ${action.visibility}) without repository binding, and save it in ${SHARED_PROJECT_CONFIG_FILE_NAME}.`,
      ];
    case 'bind':
      return [
        `Would create a project bound to the repository '${action.repositorySlug}' in organization '${action.organization}', and save it in ${SHARED_PROJECT_CONFIG_FILE_NAME}.`,
        ...(action.authorizationNeeded
          ? [
              `Organization '${action.organization}' is not linked to your DevOps platform yet: that would first be authorized in the browser.`,
            ]
          : []),
      ];
  }
}

function describe(outcome: InitOutcome, auth: ResolvedAuth | undefined, dryRun: boolean): string[] {
  switch (outcome.kind) {
    case 'dry-run':
      return describeDryRun(outcome.action);
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
      return describeMonorepo(outcome.roots, auth, dryRun);
    case 'no-monorepo-roots':
      return NO_MONOREPO_ROOTS;
  }
}

/** Prints what the run did, then the project dashboard link. The integrate offer follows it. */
export function renderInitOutcome(
  outcome: InitOutcome,
  auth: ResolvedAuth | undefined,
  console: Console,
  dryRun = false,
): void {
  for (const line of describe(outcome, auth, dryRun)) {
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
    case 'dry-run': // Nothing was mapped, so there is no dashboard to link.
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
