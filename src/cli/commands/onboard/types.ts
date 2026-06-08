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

export type {
  DiffRepository,
  DiffResult,
  LicenseInfo,
  OnboardingJob,
  OnboardingRepoProgress,
  OnboardingStage,
  RepoState,
} from '../../../sonarqube/client.js';

import type { RepoState } from '../../../sonarqube/client.js';

export interface OnboardRepository {
  fullName: string;
  estimatedLines: number;
  state: RepoState;
  archived: boolean;
  fork: boolean;
  lastPushedAt: string;
}

export interface LocAnalysisResult {
  organization: string;
  fitsInLicense: boolean;
  githubRepositoryCount: number;
  githubEstimatedLines: number;
  netNewRepositoryCount: number;
  netNewEstimatedLines: number;
  remainingLocAfterOnboarding: number;
  repositories: OnboardRepository[];
}

export type InstallMode = 'recommended' | 'manual';

export interface OrgOnboardingResult {
  org: string;
  locAnalysis: LocAnalysisResult;
  selectedRepositories: OnboardRepository[];
}

// Options chosen on the step before installation.
export interface InstallOptions {
  // Commit the workflow files directly to each repo's main branch instead of
  // opening a pull request.
  injectIntoMainBranch: boolean;
  // Configure repo-level SonarQube settings for IDE (SonarLint) connected mode.
  configureForIde: boolean;
}

export type RepoInstallStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface RepoInstallResult {
  repo: string;
  org: string;
  status: RepoInstallStatus;
  error?: string;
}

// Accumulated wizard state passed from step to step
export interface WizardContext {
  installMode?: InstallMode;
  selectedOrganizations?: string[];
  orgResults: OrgOnboardingResult[];
}
