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

// Final review — summarize all selections and options, then confirm before install.

import { blank, confirmPrompt, info, text } from '../../../../ui';
import { bold, dim, green } from '../../../../ui/colors.js';
import type { InstallOptions, OnboardRepository, OrgOnboardingResult } from '../types.js';
import type { StepperState } from './stepper.js';
import { renderStepper } from './stepper.js';
import { formatNumber } from './ui.js';

// How many repo names to list inline per org before collapsing to "+N more".
const MAX_LISTED = 5;

function sumLoc(repos: OnboardRepository[]): number {
  return repos.reduce((sum, r) => sum + r.estimatedLines, 0);
}

function printOrgSummary(result: OrgOnboardingResult): void {
  const repos = result.selectedRepositories;
  if (repos.length === 0) return;

  const noun = repos.length === 1 ? 'repository' : 'repositories';
  const loc = dim(`${formatNumber(sumLoc(repos))} est. lines`);
  blank();
  text(
    `  ${bold(result.org)}  ${dim('·')}  ${formatNumber(repos.length)} ${noun}  ${dim('·')}  ${loc}`,
  );

  const names = repos.slice(0, MAX_LISTED).map((r) => r.fullName.split('/')[1] ?? r.fullName);
  info(`  ${names.join(dim(', '))}`);

  const extra = repos.length - Math.min(repos.length, MAX_LISTED);
  if (extra > 0) info(`  ${dim(`+${formatNumber(extra)} more`)}`);
}

function printOptions(options: InstallOptions): void {
  blank();
  text(bold('Options'));
  text(
    `  ${dim('·')}  ${options.injectIntoMainBranch ? 'Commit to the main branch' : 'Open a pull request'}`,
  );
  const ide = options.configureForIde ? green('enabled') : dim('disabled');
  text(`  ${dim('·')}  IDE (SonarLint) configuration: ${ide}`);
}

/**
 * Show a summary of everything that will be onboarded — repositories per org and
 * the chosen install options — and ask the user to confirm. Returns true to
 * proceed, false to cancel (explicit No or Ctrl+C).
 */
export async function runStepReview(
  orgResults: OrgOnboardingResult[],
  options: InstallOptions,
  stepper: StepperState,
  stepIndex: number,
): Promise<boolean> {
  renderStepper(stepper, stepIndex);

  const withRepos = orgResults.filter((r) => r.selectedRepositories.length > 0);
  const totalRepos = withRepos.reduce((sum, r) => sum + r.selectedRepositories.length, 0);
  const totalLoc = withRepos.reduce((sum, r) => sum + sumLoc(r.selectedRepositories), 0);

  if (totalRepos === 0) {
    blank();
    text(dim('  No repositories selected for onboarding.'));
    blank();
    return false;
  }

  blank();
  text(dim('  The following repositories will be onboarded:'));

  for (const result of withRepos) {
    printOrgSummary(result);
  }

  blank();
  const repoNoun = totalRepos === 1 ? 'repository' : 'repositories';
  text(
    `  ${bold('Total')}  ${formatNumber(totalRepos)} ${repoNoun}  ${dim('·')}  ${formatNumber(totalLoc)} est. lines`,
  );

  printOptions(options);
  blank();

  const proceed = await confirmPrompt('Start onboarding these repositories?', true);
  return proceed === true;
}
