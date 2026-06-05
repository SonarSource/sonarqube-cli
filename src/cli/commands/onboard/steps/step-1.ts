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

// Repository analysis — fetches all orgs sequentially, appending results as they arrive

import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import { SonarQubeClient } from '../../../../sonarqube/client';
import { blank, info, note, pressEnterKeyPrompt, text, withSpinner } from '../../../../ui';
import { bold, dim, green, red, yellow } from '../../../../ui/colors.js';
import type { DiffResult, LicenseInfo, LocAnalysisResult, OnboardRepository } from '../types.js';
import { formatNumber, stepHeader } from './ui.js';

// loc-analysis returns per-repo estimated lines plus org-level aggregates. Its
// `repositories` only covers the repos we sent (the NOT_IMPORTED subset).
interface LocAnalysisResponse {
  organization: string;
  fitsInLicense: boolean;
  githubRepositoryCount: number;
  githubEstimatedLines: number;
  netNewRepositoryCount: number;
  netNewEstimatedLines: number;
  remainingLocAfterOnboarding: number;
  repositories: { fullName: string; estimatedLines: number }[];
}

function printLocBar(used: number, total: number): void {
  const BAR_WIDTH = 36;
  const pct = Math.min(used / total, 1);
  const filled = Math.round(pct * BAR_WIDTH);
  const bar = '█'.repeat(filled) + dim('░'.repeat(BAR_WIDTH - filled));
  const pctLabel = `${Math.round(pct * 100)}%`;
  const locLabel = dim(formatNumber(used) + ' / ' + formatNumber(total) + ' lines');
  text(`  ${bar}  ${pctLabel}  ${locLabel}`);
}

function printLicenseBlock(license: LicenseInfo, serverUrl: string): void {
  text(bold('License'));
  blank();
  info(`SQ Server:   ${serverUrl}`);
  info(`Edition:     ${license.edition}`);
  info(`Type:        ${license.type}`);
  info(`Supported:   ${license.supported ? green('Yes') : red('No')}`);
  const expiry = license.expired
    ? `${license.expirationDate.slice(0, 10)}${red('  (expired)')}`
    : license.expirationDate.slice(0, 10);
  info(`Expires:     ${expiry}`);
  info(`Capacity:    ${formatNumber(license.maxLoc)} lines`);
  info(`In use:      ${formatNumber(license.loc)} lines`);
  blank();
}

function printOrgImpact(
  result: LocAnalysisResult,
  license: LicenseInfo,
  runningLocAfter: number,
): void {
  const capacity = license.maxLoc;
  const fits = runningLocAfter <= capacity;
  const remaining = capacity - runningLocAfter;
  const licenseStatus = fits ? green('✓') : red('✗');

  blank();
  text(`  ${licenseStatus}  ${bold(result.organization)}`);
  info(`  Repositories found: ${formatNumber(result.githubRepositoryCount)}`);
  info(`  New repositories:   ${formatNumber(result.netNewRepositoryCount)}`);
  info(`  Estimated new LOC:  ${formatNumber(result.netNewEstimatedLines)}`);
  info(
    `  Remaining after:    ${formatNumber(remaining)} lines  ${fits ? green('fits in license') : red('exceeds license')}`,
  );
}

function printFinalLocBar(license: LicenseInfo, totalNewLoc: number): void {
  blank();
  text(bold('License usage after onboarding'));
  blank();
  printLocBar(license.loc + totalNewLoc, license.maxLoc);
  blank();

  if (license.loc + totalNewLoc > license.maxLoc) {
    note(
      'The combined estimated lines of code exceed your license capacity.\n' +
        'You may need to upgrade your license or select fewer repositories to onboard.',
      'Warning',
      { borderColor: yellow, titleColor: yellow },
    );
  }
}

/**
 * Analyze a single org: enumerate its repos via the diff endpoint, then run
 * loc-analysis only on the NOT_IMPORTED subset. Per-repo estimated lines from
 * loc-analysis are merged back onto the diff repos by fullName; the full repo
 * list (with state) comes from the diff so step-2 can report already-connected
 * repos. When no repos are NOT_IMPORTED, loc-analysis is skipped entirely.
 */
async function analyzeOrg(client: SonarQubeClient, org: string): Promise<LocAnalysisResult> {
  const diff: DiffResult = await client.getOnboardingDiff(org);

  const notImported = diff.repositories.filter((r) => r.state === 'NOT_IMPORTED');
  const loc =
    notImported.length > 0
      ? ((await client.getLocAnalysis(
          org,
          notImported.map((r) => r.fullName),
        )) as LocAnalysisResponse)
      : null;

  const estimatedByFullName = new Map(
    loc?.repositories.map((r) => [r.fullName, r.estimatedLines]) ?? [],
  );

  const repositories: OnboardRepository[] = diff.repositories.map((r) => ({
    fullName: r.fullName,
    estimatedLines: estimatedByFullName.get(r.fullName) ?? 0,
    state: r.state,
    archived: r.archived,
    fork: r.fork,
    lastPushedAt: r.lastPushedAt,
  }));

  return {
    organization: org,
    fitsInLicense: loc?.fitsInLicense ?? true,
    githubRepositoryCount: diff.totalRepositories,
    githubEstimatedLines: loc?.githubEstimatedLines ?? 0,
    netNewRepositoryCount: loc?.netNewRepositoryCount ?? 0,
    netNewEstimatedLines: loc?.netNewEstimatedLines ?? 0,
    remainingLocAfterOnboarding: loc?.remainingLocAfterOnboarding ?? 0,
    repositories,
  };
}

/**
 * Fetch license info, then per-org diff + loc-analysis in sequence, printing the
 * license block once then appending each org's impact as results arrive.
 * Returns null if any fetch fails.
 */
export async function runStep1(
  orgs: string[],
  auth: ResolvedAuth,
  stepNumber: number,
  totalSteps: number,
): Promise<LocAnalysisResult[] | null> {
  stepHeader(stepNumber, totalSteps, 'Repository analysis');

  blank();

  const client = new SonarQubeClient(auth.serverUrl, auth.token);

  const license = await withSpinner('Fetching license…', () => client.getLicense());

  blank();
  printLicenseBlock(license, auth.serverUrl);

  const results: LocAnalysisResult[] = [];
  let runningNewLoc = 0;

  for (const org of orgs) {
    const result = await withSpinner(`Analyzing ${org}…`, () => analyzeOrg(client, org));

    runningNewLoc += result.netNewEstimatedLines;
    printOrgImpact(result, license, license.loc + runningNewLoc);
    results.push(result);
  }

  if (results.length > 0) {
    printFinalLocBar(license, runningNewLoc);
  }

  // pressEnterKeyPrompt always resolves (no cancel path); it's used purely for pacing
  await pressEnterKeyPrompt('Press Enter to continue to repository selection…');
  return results;
}
