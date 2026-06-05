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

// Step 1 of 3 — Authenticate with GitHub and select organizations to onboard

import { resolveGitHubToken } from '../../../../lib/github-auth.js';
import { GitHubClient } from '../../../../sonarqube/github-client.js';
import { blank, multiSelectPrompt, withSpinner } from '../../../../ui';
import type { WizardContext } from '../types.js';
import { stepHeader } from './ui.js';

export async function runStep0(
  ctx: WizardContext,
  stepNumber: number,
  totalSteps: number,
): Promise<boolean> {
  stepHeader(stepNumber, totalSteps, 'Select organizations');

  const token = await resolveGitHubToken();
  const client = new GitHubClient(token);

  const orgs = await withSpinner('Fetching your GitHub organizations…', () =>
    client.listOrganizations(),
  );

  if (orgs.length === 0) {
    blank();
    // Nothing to onboard — exit gracefully rather than showing an empty prompt
    return false;
  }

  blank();

  const selected = await multiSelectPrompt(
    'Which organizations do you want to onboard?',
    orgs.map((org) => ({ value: org.login, label: org.login })),
    { selectAll: true },
  );

  // null = Ctrl+C, empty array = confirmed with nothing selected
  if (selected === null || selected.length === 0) {
    return false;
  }

  ctx.selectedOrganizations = selected;
  return true;
}
