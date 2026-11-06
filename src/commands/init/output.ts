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

import type { InitOutcome } from './init-outcome.ts';
import { projectDashboardUrl } from './steps/mapping.ts';

const INTEGRATE_SUGGESTION = "Next, run 'sonar integrate' to set up your coding agents.";
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
  }
}

/**
 * Prints what the run did, then the project dashboard link, then the `sonar integrate` hint. The
 * link comes before anything about integrating, so a run reads: result, where to see it, next step.
 */
export function renderInitOutcome(
  outcome: InitOutcome,
  auth: ResolvedAuth | undefined,
  console: Console,
  { suggestIntegrate }: { suggestIntegrate: boolean },
): void {
  for (const line of describe(outcome)) {
    console.print(line);
  }
  if (auth) {
    renderProjectDashboards(outcome, auth, console);
  }
  if (suggestIntegrate) {
    console.print(INTEGRATE_SUGGESTION);
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
    case 'declined':
    case 'no-organization':
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
