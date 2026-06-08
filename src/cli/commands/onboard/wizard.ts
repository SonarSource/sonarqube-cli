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
import { analyzeOrgsHeadless, runStep1 } from './steps/step-1.js';
import { runStep2 } from './steps/step-2.js';
import { runStepInstall } from './steps/step-install.js';
import { runInstallModeStep } from './steps/step-install-mode.js';
import { runStepOptions } from './steps/step-options.js';
import { runStepReview } from './steps/step-review.js';
import type { StepDef, StepperState } from './steps/stepper.js';
import { createStepper, setOutcome } from './steps/stepper.js';
import { formatNumber } from './steps/ui.js';
import type {
  InstallOptions,
  LicenseInfo,
  LocAnalysisResult,
  OnboardRepository,
  OrgOnboardingResult,
  WizardContext,
} from './types.js';

// Defaults applied in the recommended fast-path: open a PR (don't commit to
// main) and configure repos for IDE / SonarLint connected mode.
const RECOMMENDED_OPTIONS: InstallOptions = {
  injectIntoMainBranch: false,
  configureForIde: true,
};

// Step definitions per mode. The stepper renders these as a breadcrumb panel.
const MANUAL_STEPS: StepDef[] = [
  { key: 'orgs', title: 'Select organizations' },
  { key: 'analysis', title: 'Repository analysis' },
  { key: 'select', title: 'Select repositories' },
  { key: 'options', title: 'Installation options' },
  { key: 'review', title: 'Review' },
  { key: 'install', title: 'Install' },
];
const RECOMMENDED_STEPS: StepDef[] = [
  { key: 'review', title: 'Review' },
  { key: 'install', title: 'Install' },
];

// Repos eligible for onboarding: not already imported, not archived, not forks.
// Mirrors the candidate filter in step-2.
function isCandidate(repo: OnboardRepository): boolean {
  return repo.state === 'NOT_IMPORTED' && !repo.archived && !repo.fork;
}

interface Prepared {
  orgResults: OrgOnboardingResult[];
  installOptions: InstallOptions;
}

function totalSelectedLoc(orgResults: OrgOnboardingResult[]): number {
  return orgResults.reduce(
    (sum, r) => sum + r.selectedRepositories.reduce((s, repo) => s + repo.estimatedLines, 0),
    0,
  );
}

function totalSelectedRepos(orgResults: OrgOnboardingResult[]): number {
  return orgResults.reduce((sum, r) => sum + r.selectedRepositories.length, 0);
}

function optionsOutcome(options: InstallOptions): string {
  const branch = options.injectIntoMainBranch ? 'main branch' : 'PR';
  const ide = options.configureForIde ? 'IDE on' : 'IDE off';
  return `${branch} · ${ide}`;
}

export async function runOnboardingWizard(auth: ResolvedAuth): Promise<void> {
  intro('SonarQube Onboarding');

  const ctx: WizardContext = { orgResults: [] };

  if (!(await runInstallModeStep(ctx))) {
    outro('Onboarding cancelled', 'error');
    return;
  }

  // Recommended fast-path: 2 steps (review, install). Manual: 6 steps
  // (orgs, analysis, select, options, review, install) — repo selection also
  // fetches and shows the AI recommendation, so there is no separate step.
  const isManual = ctx.installMode === 'manual';
  const stepper = createStepper(isManual ? MANUAL_STEPS : RECOMMENDED_STEPS);

  const prepared = isManual
    ? await prepareManual(ctx, auth, stepper)
    : await prepareRecommended(ctx, auth);

  if (prepared === null) {
    outro('Onboarding cancelled', 'error');
    return;
  }

  // The review/install steps are the last two in either mode.
  const reviewIndex = stepper.steps.length - 2;
  const installIndex = stepper.steps.length - 1;

  // Final review before anything is written. Cancellable.
  const proceed = await runStepReview(
    prepared.orgResults,
    prepared.installOptions,
    stepper,
    reviewIndex,
  );
  if (!proceed) {
    outro('Onboarding cancelled', 'error');
    return;
  }
  setOutcome(stepper, 'review', 'confirmed');

  // Install: start onboarding jobs for every selected repository and watch progress
  await runStepInstall(prepared.orgResults, prepared.installOptions, auth, stepper, installIndex);

  outro('Onboarding complete');
}

/**
 * Recommended fast-path: fetch all GitHub orgs, analyze them headlessly, and
 * auto-select every eligible repository with default options. No interactive
 * steps — flows straight to the review.
 */
async function prepareRecommended(
  ctx: WizardContext,
  auth: ResolvedAuth,
): Promise<Prepared | null> {
  const token = await resolveGitHubToken();
  const client = new GitHubClient(token);
  const githubOrgs = await withSpinner('Fetching your GitHub organizations…', () =>
    client.listOrganizations(),
  );
  const orgs = githubOrgs.map((o) => o.login);
  if (orgs.length === 0) {
    outro('No organizations found to onboard', 'error');
    return null;
  }

  const { results } = await withSpinner('Analyzing your repositories…', () =>
    analyzeOrgsHeadless(auth, orgs),
  );

  ctx.orgResults = results.map((locAnalysis) => ({
    org: locAnalysis.organization,
    locAnalysis,
    selectedRepositories: locAnalysis.repositories.filter(isCandidate),
  }));

  return { orgResults: ctx.orgResults, installOptions: RECOMMENDED_OPTIONS };
}

/**
 * Manual path: org selection, analysis, per-org repo selection (which now also
 * fetches and shows the AI recommendation), then install options. Returns null
 * if the user cancels any step.
 */
async function prepareManual(
  ctx: WizardContext,
  auth: ResolvedAuth,
  stepper: StepperState,
): Promise<Prepared | null> {
  // orgs(0) / analysis(1) / select(2) / options(3) within MANUAL_STEPS.
  if (!(await runStep0(ctx, stepper, 0))) return null;
  const orgs = ctx.selectedOrganizations ?? [];
  if (orgs.length === 0) {
    outro('No organizations found to onboard', 'error');
    return null;
  }
  setOutcome(stepper, 'orgs', `${formatNumber(orgs.length)} selected`);

  const { license, results: locResults } = await runStep1(orgs, auth, stepper, 1);
  const analyzed = locResults.reduce((sum, r) => sum + r.netNewEstimatedLines, 0);
  const fits = license.loc + analyzed <= license.maxLoc;
  setOutcome(stepper, 'analysis', fits ? 'fits license' : 'exceeds license');

  const completed = await selectRepositoriesPerOrg(ctx, locResults, license, auth, stepper, 2);
  if (!completed) return null;
  const repos = totalSelectedRepos(ctx.orgResults);
  setOutcome(
    stepper,
    'select',
    `${formatNumber(repos)} repos · ${formatNumber(totalSelectedLoc(ctx.orgResults))} LOC`,
  );

  const installOptions = await runStepOptions(stepper, 3);
  if (installOptions === null) return null;
  setOutcome(stepper, 'options', optionsOutcome(installOptions));

  return { orgResults: ctx.orgResults, installOptions };
}

/**
 * Run repo selection once per org, appending results onto `ctx`. Each pass also
 * fetches the AI recommendation for that org (inside `runStep2`). Tracks LOC
 * committed in earlier orgs so the live capacity bar reflects the cumulative
 * running total. Returns false if the user cancelled any selection.
 */
async function selectRepositoriesPerOrg(
  ctx: WizardContext,
  locResults: LocAnalysisResult[],
  license: LicenseInfo,
  auth: ResolvedAuth,
  stepper: StepperState,
  stepIndex: number,
): Promise<boolean> {
  let committedLoc = 0;
  for (let i = 0; i < locResults.length; i++) {
    const locAnalysis = locResults[i];
    const selectedRepositories = await runStep2(
      locAnalysis,
      { loc: license.loc, maxLoc: license.maxLoc, committedLoc },
      auth,
      stepper,
      stepIndex,
      { index: i, total: locResults.length },
    );
    if (selectedRepositories === null) return false;
    committedLoc += selectedRepositories.reduce((sum, r) => sum + r.estimatedLines, 0);
    ctx.orgResults.push({ org: locAnalysis.organization, locAnalysis, selectedRepositories });
  }
  return true;
}
