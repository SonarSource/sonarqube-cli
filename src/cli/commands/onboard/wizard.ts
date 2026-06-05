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

import type { ResolvedAuth } from '../../../lib/auth-resolver';
import { resolveGitHubToken } from '../../../lib/github-auth.js';
import { GitHubClient } from '../../../sonarqube/github-client.js';
import { intro, outro, withSpinner } from '../../../ui';
import { runStep0 } from './steps/step-0.js';
import { runStep1 } from './steps/step-1.js';
import { runStep2 } from './steps/step-2.js';
import { runStepInstall } from './steps/step-install.js';
import { runInstallModeStep } from './steps/step-install-mode.js';
import type { WizardContext } from './types.js';

export async function runOnboardingWizard(auth: ResolvedAuth): Promise<void> {
  intro('SonarQube Onboarding');

  const ctx: WizardContext = { orgResults: [] };

  if (!(await runInstallModeStep(ctx))) {
    outro('Onboarding cancelled', 'error');
    return;
  }

  const isManual = ctx.installMode === 'manual';

  let orgs: string[];

  if (isManual) {
    // Manual: user selects orgs explicitly (step 1 of 3)
    if (!(await runStep0(ctx, 1, 3))) {
      outro('Onboarding cancelled', 'error');
      return;
    }
    orgs = ctx.selectedOrganizations ?? [];
  } else {
    // Recommended: fetch all GitHub orgs automatically
    const token = await resolveGitHubToken();
    const client = new GitHubClient(token);
    const githubOrgs = await withSpinner('Fetching your GitHub organizations…', () =>
      client.listOrganizations(),
    );
    orgs = githubOrgs.map((o) => o.login);
  }

  if (orgs.length === 0) {
    outro('No organizations found to onboard', 'error');
    return;
  }

  // Manual: steps 2/3/4 of 4. Recommended: steps 1/2/3 of 3.
  const totalSteps = isManual ? 4 : 3;
  const analysisStep = isManual ? 2 : 1;
  const repoStep = isManual ? 3 : 2;
  const installStep = isManual ? 4 : 3;

  // Fetch all orgs in one step — license shown once, org rows appended as they arrive
  const locResults = await runStep1(orgs, auth, analysisStep, totalSteps);
  if (locResults === null) {
    outro('Onboarding cancelled', 'error');
    return;
  }

  // Repo selection: one pass per org
  for (let i = 0; i < locResults.length; i++) {
    const locAnalysis = locResults[i];
    const selectedRepositories = await runStep2(
      locAnalysis,
      repoStep,
      totalSteps,
      i,
      locResults.length,
      { preSelectAll: !isManual },
    );
    if (selectedRepositories === null) {
      outro('Onboarding cancelled', 'error');
      return;
    }
    ctx.orgResults.push({ org: locAnalysis.organization, locAnalysis, selectedRepositories });
  }

  // Install: ingest SonarQube config files into every selected repository
  await runStepInstall(ctx.orgResults, installStep, totalSteps);

  outro('Onboarding complete');
}
