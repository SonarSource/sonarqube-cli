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

import type {
  FailedResult,
  OnboardCiOptions,
  OnboardCiResults as SharedOnboardCiResults,
  OpenedResult,
  RepoProject,
  SkippedResult as SharedSkippedResult,
} from '../types.ts';

export const GITLAB_DEFAULT_STAGES = new Set(['.pre', 'build', 'test', 'deploy', '.post']);
export const GITLAB_IMPLICIT_STAGES = new Set(['.pre', '.post']);

export enum TriggerOn {
  Mr = 'mr',
  Main = 'main',
  Both = 'both',
}

export enum SkipReason {
  AlreadyConfigured = 'ALREADY_CONFIGURED',
  OtherCiDetected = 'OTHER_CI_DETECTED',
  MrAlreadyOpen = 'MR_ALREADY_OPEN',
  StageNotInCi = 'STAGE_NOT_IN_CI',
  CustomCiConfigPath = 'CUSTOM_CI_CONFIG_PATH',
  NotInSonarQube = 'NOT_IN_SONARQUBE',
}

export interface OnboardCiGitlabOptions extends OnboardCiOptions {
  group: string;
  sonarTokenVarName: string;
  triggerOn: TriggerOn;
  stage?: string;
  allowFailure: boolean;
  scannerProperty: string[];
  jobTemplate?: string;
}

type GenerationOption = 'sonarTokenVarName' | 'triggerOn' | 'scannerProperty';
export type OnboardCiGitlabInput = Omit<OnboardCiGitlabOptions, GenerationOption> &
  Partial<Pick<OnboardCiGitlabOptions, GenerationOption>>;

export type SkippedResult = SharedSkippedResult;

export type OnboardCiResults = SharedOnboardCiResults<OpenedResult, SkippedResult>;
export type DryRunEntry = RepoProject;
export type DryRunSkippedEntry = SharedSkippedResult;
export type DryRunFailedEntry = FailedResult;

export interface DryRunResults {
  wouldOpenMr: DryRunEntry[];
  wouldSkip: DryRunSkippedEntry[];
  failed: DryRunFailedEntry[];
}
