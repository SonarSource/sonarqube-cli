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

import * as yaml from 'js-yaml';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import type { GitLabClient, GitLabRepo, GitLabTreeEntry } from '@/core/gitlab/client.ts';
import { GitLabApiError } from '@/core/gitlab/client.ts';
import { HTTP_STATUS_BAD_REQUEST } from '@/core/http-constants.ts';
import type { SonarQubeClient } from '@/core/server/client.ts';

import { buildUpdatedCiYml, generateCiYml, generateMrDescription } from './templates.ts';
import type { OnboardCiGitlabOptions } from './types.ts';
import { GITLAB_DEFAULT_STAGES, GITLAB_IMPLICIT_STAGES, SkipReason } from './types.ts';

const DEFAULT_CI_FILE = '.gitlab-ci.yml';
const CI_BRANCH = 'sonar/add-sonar-analysis-job';

enum OtherCiMarker {
  Jenkinsfile = 'Jenkinsfile',
  AzurePipelines = 'azure-pipelines.yml',
  CircleCi = '.circleci',
  TravisCi = '.travis.yml',
}

enum SonarCiMarker {
  SonarScanner = 'sonar-scanner',
  SonarHostUrl = 'SONAR_HOST_URL',
  SonarqubeAnalysis = 'sonarqube-analysis:',
}

export type RepoWithBranch = GitLabRepo & { default_branch: string };

export interface ProcessRepoContext {
  gitlab: GitLabClient;
  sqs: SonarQubeClient;
  dopSettingId: string;
  auth: ResolvedAuth;
  options: OnboardCiGitlabOptions;
}

export type RepoClassification =
  | { outcome: 'skip'; reason: SkipReason; message: string; mrUrl?: string }
  | {
      outcome: 'proceed';
      ciFilePath: string;
      existingCi: string | null;
      projectKey: string;
    };

export type ExecuteResult = { outcome: 'opened'; projectKey: string; mrUrl: string };

function isBranchAlreadyExistsError(err: unknown): boolean {
  return (
    err instanceof GitLabApiError &&
    err.status === HTTP_STATUS_BAD_REQUEST &&
    err.body.includes('Branch already exists')
  );
}

function stageConflicts(existingCiContent: string, requestedStage: string): boolean {
  if (GITLAB_IMPLICIT_STAGES.has(requestedStage)) return false;
  try {
    const parsed = yaml.load(existingCiContent);
    if (parsed == null || typeof parsed !== 'object') return false;
    const stages = (parsed as Record<string, unknown>).stages;
    if (!Array.isArray(stages)) return !GITLAB_DEFAULT_STAGES.has(requestedStage);
    return !stages.includes(requestedStage);
  } catch {
    return false;
  }
}

export async function classifyRepo(
  ctx: ProcessRepoContext,
  repo: RepoWithBranch,
  bindingMap: Map<string, string>,
): Promise<RepoClassification> {
  const existingProjectKey = bindingMap.get(String(repo.id));
  if (!existingProjectKey) {
    return {
      outcome: 'skip',
      reason: SkipReason.NotInSonarQube,
      message: 'skipped (not bound in SonarQube)',
    };
  }

  if (await ctx.sqs.hasProjectBeenAnalyzed(existingProjectKey)) {
    return {
      outcome: 'skip',
      reason: SkipReason.AlreadyConfigured,
      message: 'skipped (already configured)',
    };
  }

  const ciConfigPath = await ctx.gitlab.getProjectCiConfigPath(repo.id);
  if (ciConfigPath?.includes('@')) {
    return {
      outcome: 'skip',
      reason: SkipReason.CustomCiConfigPath,
      message: `skipped (external CI config: ${ciConfigPath})`,
    };
  }
  const ciFilePath = ciConfigPath ?? DEFAULT_CI_FILE;

  const rawCi = await ctx.gitlab.getFileContent(repo.id, ciFilePath, repo.default_branch);
  const existingCi = rawCi === '' ? null : rawCi;

  if (existingCi !== null) {
    if (Object.values(SonarCiMarker).some((marker) => existingCi.includes(marker))) {
      return {
        outcome: 'skip',
        reason: SkipReason.AlreadyConfigured,
        message: 'skipped (already configured)',
      };
    }

    const effectiveStage = ctx.options.stage ?? 'test';
    if (stageConflicts(existingCi, effectiveStage)) {
      return {
        outcome: 'skip',
        reason: SkipReason.StageNotInCi,
        message: `skipped (stage '${effectiveStage}' not defined in ${ciFilePath})`,
      };
    }
  } else {
    const treeEntries = await ctx.gitlab.listRepoTree(repo.id, repo.default_branch);
    const rootFiles = new Set<string>(treeEntries.map((f: GitLabTreeEntry) => f.name));

    if (Object.values(OtherCiMarker).some((f) => rootFiles.has(f))) {
      return {
        outcome: 'skip',
        reason: SkipReason.OtherCiDetected,
        message: 'skipped (other CI detected)',
      };
    }

    if (rootFiles.has('sonar-project.properties')) {
      return {
        outcome: 'skip',
        reason: SkipReason.AlreadyConfigured,
        message: 'skipped (already configured)',
      };
    }
  }

  const openMrs = await ctx.gitlab.listOpenMergeRequests(repo.id, CI_BRANCH);
  if (openMrs.length > 0) {
    return {
      outcome: 'skip',
      reason: SkipReason.MrAlreadyOpen,
      message: 'skipped (MR already open)',
      mrUrl: openMrs[0].web_url,
    };
  }

  return { outcome: 'proceed', ciFilePath, existingCi, projectKey: existingProjectKey };
}

export async function executeRepo(
  ctx: ProcessRepoContext,
  repo: RepoWithBranch,
  classification: Extract<RepoClassification, { outcome: 'proceed' }>,
): Promise<ExecuteResult> {
  const { ciFilePath, existingCi, projectKey } = classification;

  try {
    await ctx.gitlab.createBranch(repo.id, CI_BRANCH);
  } catch (err) {
    if (isBranchAlreadyExistsError(err)) {
      await ctx.gitlab.deleteBranch(repo.id, CI_BRANCH);
      await ctx.gitlab.createBranch(repo.id, CI_BRANCH);
    } else {
      throw err;
    }
  }

  const ciYml = generateCiYml(projectKey, ctx.auth.serverUrl, ctx.options, existingCi === null);
  const updatedCi = buildUpdatedCiYml(existingCi, ciYml);
  if (existingCi === null) {
    await ctx.gitlab.createFile(
      repo.id,
      ciFilePath,
      CI_BRANCH,
      updatedCi,
      `Add ${ciFilePath} with SonarQube analysis`,
    );
  } else {
    await ctx.gitlab.updateFile(
      repo.id,
      ciFilePath,
      CI_BRANCH,
      updatedCi,
      'Add SonarQube analysis job',
    );
  }

  const mrUrl = await ctx.gitlab.createMergeRequest(
    repo.id,
    CI_BRANCH,
    repo.default_branch,
    'Configure SonarQube CI analysis',
    generateMrDescription(
      projectKey,
      ctx.auth.serverUrl,
      ciFilePath,
      ctx.options.sonarTokenVarName,
      ctx.options.triggerOn,
    ),
  );

  return { outcome: 'opened', projectKey, mrUrl };
}
