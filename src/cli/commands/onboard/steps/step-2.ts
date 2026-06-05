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

// Select repositories to onboard for a single organization

import { blank, info, multiSelectPrompt, note, text } from '../../../../ui';
import { bold, dim, green } from '../../../../ui/colors.js';
import type { LocAnalysisResult, OnboardRepository } from '../types.js';
import { formatNumber, stepHeader } from './ui.js';

function repoLabel(repo: OnboardRepository): string {
  const name = repo.fullName.split('/')[1] ?? repo.fullName;
  const loc = dim(`${formatNumber(repo.estimatedLines)} est. lines`);
  return `${name}  ${loc}`;
}

function printSelectionSummary(selected: OnboardRepository[], remainingLoc: number): void {
  const totalLoc = selected.reduce((sum, r) => sum + r.estimatedLines, 0);
  const licenseStatus =
    totalLoc <= remainingLoc ? green('✓ fits in license') : dim('(exceeds available capacity)');

  blank();
  text(bold('Selection summary'));
  blank();
  info(`Repositories selected: ${formatNumber(selected.length)}`);
  info(`Estimated LOC:         ${formatNumber(totalLoc)}  ${licenseStatus}`);
}

// Returns selected repositories, or null if the user cancelled.
export async function runStep2(
  locAnalysis: LocAnalysisResult,
  stepNumber: number,
  totalSteps: number,
  orgIndex: number,
  orgTotal: number,
  { preSelectAll = false }: { preSelectAll?: boolean } = {},
): Promise<OnboardRepository[] | null> {
  const orgCounter = dim(`(${String(orgIndex + 1)} of ${String(orgTotal)})`);
  const orgSuffix = orgTotal > 1 ? `  ${orgCounter}` : '';
  stepHeader(stepNumber, totalSteps, `Select repositories${orgSuffix}`);

  blank();
  text(`  Organization: ${bold(locAnalysis.organization)}`);
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

  const selected = await multiSelectPrompt(
    'Which repositories do you want to onboard?',
    candidates.map((r) => ({ value: r, label: repoLabel(r) })),
    { selectAll: true, preSelectAll },
  );

  if (selected === null) return null;

  printSelectionSummary(selected, locAnalysis.remainingLocAfterOnboarding);
  blank();

  return selected;
}
