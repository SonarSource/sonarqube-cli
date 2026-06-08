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

// Select repositories to onboard for a single organization.
//
// This step also fetches the AI recommendation for the org (mocked via
// `SonarQubeClient.getOnboardingRecommendations`) so the model's explanation,
// its ✨-marked picks, and the live checklist all appear on the same screen.

import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import { SonarQubeClient } from '../../../../sonarqube/client';
import { blank, info, multiSelectPrompt, note, text, withSpinner } from '../../../../ui';
import { bold, cyan, dim, green, red } from '../../../../ui/colors.js';
import type { LocAnalysisResult, OnboardRepository } from '../types.js';
import type { StepperState } from './stepper.js';
import { renderStepper } from './stepper.js';
import { formatNumber, locBar } from './ui.js';

const SPARKLES = '✨';

// The AI recommendation for a single org: the recommended repository fullNames
// and the model's explanation of why it chose them.
interface OrgRecommendation {
  recommended: Set<string>;
  explanation: string;
}

// License-usage context for the live capacity bar. `loc` is the LOC already in
// use before onboarding; `committedLoc` is the LOC selected in previous orgs in
// this same wizard run, so the bar reflects the cumulative running total.
export interface CapacityContext {
  loc: number;
  maxLoc: number;
  committedLoc: number;
}

function repoLabel(repo: OnboardRepository, recommended: boolean): string {
  const name = repo.fullName.split('/')[1] ?? repo.fullName;
  const separator = dim('·');
  const loc = `${cyan(formatNumber(repo.estimatedLines))} ${dim('est. lines')}`;
  const badge = recommended ? `${green('✨')} ` : '';
  return `${badge}${name}  ${separator}  ${loc}`;
}

function sumLoc(repos: OnboardRepository[]): number {
  return repos.reduce((sum, r) => sum + r.estimatedLines, 0);
}

// True license capacity still available to this org: total capacity minus the
// LOC already in use and the LOC committed onboarding earlier orgs in this run.
// This is the same basis as the live capacity bar, so the AI's budget reasoning
// matches what the user sees — unlike LocAnalysisResult.remainingLocAfterOnboarding,
// which assumes every net-new repo is onboarded.
function remainingCapacity(capacity: CapacityContext): number {
  return Math.max(capacity.maxLoc - capacity.loc - capacity.committedLoc, 0);
}

/**
 * Build the live capacity bar shown under the repo list. `selectionLoc` is the
 * LOC of the repos currently checked in this org; it's added to the LOC already
 * in use and to the LOC committed in previous orgs to show the cumulative
 * license usage as the user toggles repos.
 */
function capacityFooter(capacity: CapacityContext, selectionLoc: number): string {
  const used = capacity.loc + capacity.committedLoc + selectionLoc;
  const fits = used <= capacity.maxLoc;
  const over = used - capacity.maxLoc;
  const status = fits
    ? green('✓ fits in license')
    : red(`✗ exceeds license by ${formatNumber(over)} lines`);
  return ['', locBar(used, capacity.maxLoc), `  ${status}`].join('\n');
}

function printSelectionSummary(selected: OnboardRepository[], capacity: CapacityContext): void {
  const selectionLoc = sumLoc(selected);
  const used = capacity.loc + capacity.committedLoc + selectionLoc;
  const fits = used <= capacity.maxLoc;
  const licenseStatus = fits ? green('✓ fits in license') : red('✗ exceeds license');

  blank();
  text(bold('Selection summary'));
  blank();
  info(`Repositories selected: ${formatNumber(selected.length)}`);
  info(`Estimated new LOC:     ${formatNumber(selectionLoc)}`);
  info(
    `License usage:         ${formatNumber(used)} / ${formatNumber(capacity.maxLoc)}  ${licenseStatus}`,
  );
}

/**
 * Ask the (mocked) LLM endpoint which of `candidates` to onboard for this org,
 * given the remaining license capacity. Returns the recommended fullNames and
 * the model's explanation. Shown on the same screen as the selection list.
 */
async function fetchRecommendation(
  auth: ResolvedAuth,
  locAnalysis: LocAnalysisResult,
  candidates: OnboardRepository[],
  capacity: CapacityContext,
): Promise<OrgRecommendation> {
  const client = new SonarQubeClient(auth.serverUrl, auth.token);
  const result = await withSpinner(
    `Asking AI to recommend repositories for ${locAnalysis.organization}…`,
    () =>
      client.getOnboardingRecommendations({
        organization: locAnalysis.organization,
        // True remaining capacity (matches the live bar), not the analysis field.
        remainingLoc: remainingCapacity(capacity),
        repositories: candidates.map((r) => ({
          fullName: r.fullName,
          estimatedLines: r.estimatedLines,
          lastPushedAt: r.lastPushedAt,
        })),
      }),
  );
  return {
    recommended: new Set(result.repos.map((r) => r.fullName)),
    explanation: result.explanation,
  };
}

// Where this org sits in the per-org selection loop (for the "(N of M)" label).
export interface OrgPosition {
  index: number;
  total: number;
}

// Returns selected repositories, or null if the user cancelled.
export async function runStep2(
  locAnalysis: LocAnalysisResult,
  capacity: CapacityContext,
  auth: ResolvedAuth,
  stepper: StepperState,
  stepIndex: number,
  position: OrgPosition,
  { preSelectAll = false }: { preSelectAll?: boolean } = {},
): Promise<OnboardRepository[] | null> {
  renderStepper(stepper, stepIndex);

  blank();
  const counterLabel = `(${String(position.index + 1)} of ${String(position.total)})`;
  const orgCounter = position.total > 1 ? `  ${dim(counterLabel)}` : '';
  text(`  Organization: ${bold(locAnalysis.organization)}${orgCounter}`);
  blank();

  const repos = locAnalysis.repositories;
  const candidates = repos.filter((r) => r.state === 'NOT_IMPORTED' && !r.archived && !r.fork);
  const alreadyConnected = repos.filter((r) => r.state !== 'NOT_IMPORTED');

  if (alreadyConnected.length > 0) {
    const count = alreadyConnected.length;
    const label = count === 1 ? 'repository is' : 'repositories are';
    note(`${formatNumber(count)} ${label} already connected to SonarQube and will be skipped.`);
    blank();
  }

  if (candidates.length === 0) {
    note('All repositories in your organization are already connected to SonarQube.');
    return [];
  }

  // Fetch the AI recommendation and show its explanation right above the list,
  // so the picks (✨), the rationale, and the checklist are all on one screen.
  const recommendation = await fetchRecommendation(auth, locAnalysis, candidates, capacity);
  const isRecommended = (repo: OnboardRepository): boolean =>
    recommendation.recommended.has(repo.fullName);

  const hasRecommendations = candidates.some(isRecommended);
  if (hasRecommendations) {
    const explanation = recommendation.explanation.trim();
    note(
      explanation
        ? `${explanation}\n\nRepositories marked ✨ are AI-recommended and pre-selected. Adjust as needed.`
        : 'Repositories marked ✨ are AI-recommended and pre-selected. Adjust as needed.',
      `${SPARKLES} AI recommendation`,
    );
    blank();
  }

  // Live capacity bar redrawn under the list as repos are toggled.
  const footer = (sel: OnboardRepository[]): string => capacityFooter(capacity, sumLoc(sel));

  const selected = await multiSelectPrompt(
    'Which repositories do you want to onboard?',
    candidates.map((r) => ({ value: r, label: repoLabel(r, isRecommended(r)) })),
    // When recommendations exist, pre-check only those; otherwise fall back to
    // pre-selecting everything in recommended mode.
    hasRecommendations
      ? { selectAll: true, preSelected: isRecommended, footer }
      : { selectAll: true, preSelectAll, footer },
  );

  if (selected === null) return null;

  printSelectionSummary(selected, capacity);
  blank();

  return selected;
}
