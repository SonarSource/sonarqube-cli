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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { GitHubClient, GitHubRepo } from '@/core/github/client.ts';
import type { ComponentsClient } from '@/core/server/components.ts';

import type { WorkflowOptions } from './templates.ts';
import {
  generatePrContent,
  generateTemplatePrContent,
  generateWorkflow,
  renderWorkflowTemplate,
  validateWorkflowOptions,
  WORKFLOW_PATH,
} from './templates.ts';

export const CI_BRANCH = 'sonar/add-sonar-analysis-job';

export interface ProcessRepoContext {
  github: GitHubClient;
  components: ComponentsClient;
  serverUrl: string;
  options: WorkflowOptions;
  workflowTemplate?: string;
}

type SkippedResult = { outcome: 'skip'; reason: string; prUrl?: string };
type FailedResult = { outcome: 'failed'; error: string };
type EligibleResult = {
  outcome: 'proceed';
  projectKey: string;
  workflow: string;
  title: string;
  body: string;
};
export type RepoAssessment = EligibleResult | SkippedResult | FailedResult;
export type ExecuteResult =
  { outcome: 'opened'; projectKey: string; prUrl: string } | SkippedResult | FailedResult;

function failure(error: unknown): FailedResult {
  return { outcome: 'failed', error: error instanceof Error ? error.message : String(error) };
}

async function retrieveOpenPrUrl(
  ctx: ProcessRepoContext,
  repo: string,
): Promise<string | undefined> {
  const prs = await ctx.github.listOpenPullRequests(repo, CI_BRANCH);
  return prs[0]?.html_url;
}

async function assessWorkflows(
  ctx: ProcessRepoContext,
  repo: GitHubRepo,
): Promise<SkippedResult | undefined> {
  const workflows = await ctx.github.listRepoTree(
    repo.full_name,
    '.github/workflows',
    repo.default_branch,
  );
  if (workflows.some((entry) => entry.path === WORKFLOW_PATH)) {
    return { outcome: 'skip', reason: 'WORKFLOW_COLLISION' };
  }
  for (const entry of workflows.filter((entry) => /\.ya?ml$/i.test(entry.name))) {
    if (entry.type !== 'file') {
      return { outcome: 'skip', reason: 'UNSUPPORTED_WORKFLOW' };
    }
    const content = await ctx.github.getFileContent(
      repo.full_name,
      entry.path,
      repo.default_branch,
    );
    if (content === null) {
      throw new CommandFailedError(
        `Workflow '${entry.path}' disappeared during assessment; run onboarding again.`,
      );
    }
    if (
      /sonar-scanner|sonarscanner|sonar:sonar|(?:gradle|gradlew)\s+sonar\b|sonarqube-scan-action|sonarcloud-github-action|sonarqube-github-action|SONAR_HOST_URL|SONAR_TOKEN|sonar\.projectKey/.test(
        content,
      )
    ) {
      return { outcome: 'skip', reason: 'ALREADY_CONFIGURED' };
    }
  }
  return undefined;
}

export async function assessRepo(
  ctx: ProcessRepoContext,
  repo: GitHubRepo,
  bindings: ReadonlyMap<string, string>,
): Promise<RepoAssessment> {
  try {
    const projectKey = bindings.get(repo.full_name);
    if (!projectKey) {
      return { outcome: 'skip', reason: 'NOT_IN_SONARQUBE' };
    }
    if (repo.archived || repo.disabled || !repo.default_branch) {
      return { outcome: 'skip', reason: 'UNSUPPORTED_REPOSITORY' };
    }
    if (!(await ctx.components.componentExists(projectKey).orThrow())) {
      throw new CommandFailedError(
        `Bound SonarQube project '${projectKey}' is missing or inaccessible.`,
      );
    }
    if (await ctx.components.hasProjectBeenAnalyzed(projectKey).orThrow()) {
      return { outcome: 'skip', reason: 'ALREADY_ANALYZED' };
    }
    const prUrl = await retrieveOpenPrUrl(ctx, repo.full_name);
    if (prUrl) {
      return { outcome: 'skip', reason: 'PR_ALREADY_OPEN', prUrl };
    }
    if (
      (await ctx.github.getFileContent(
        repo.full_name,
        'sonar-project.properties',
        repo.default_branch,
      )) !== null
    ) {
      return { outcome: 'skip', reason: 'ALREADY_CONFIGURED' };
    }
    const workflowAssessment = await assessWorkflows(ctx, repo);
    if (workflowAssessment) {
      return workflowAssessment;
    }
    validateWorkflowOptions(ctx.options, ctx.workflowTemplate);
    if (ctx.workflowTemplate !== undefined) {
      return {
        outcome: 'proceed',
        projectKey,
        workflow: renderWorkflowTemplate(ctx.workflowTemplate, projectKey),
        ...generateTemplatePrContent(projectKey),
      };
    }
    return {
      outcome: 'proceed',
      projectKey,
      workflow: generateWorkflow(projectKey, ctx.serverUrl, repo.default_branch, ctx.options),
      ...generatePrContent(projectKey, ctx.serverUrl, ctx.options),
    };
  } catch (error) {
    return failure(error);
  }
}

async function prepareOnboardingBranch(
  ctx: ProcessRepoContext,
  repo: GitHubRepo,
  baseSha: string,
): Promise<SkippedResult | undefined> {
  if (await ctx.github.getBranch(repo.full_name, CI_BRANCH)) {
    // Recheck before deleting: preserve a PR opened since assessment.
    const prUrl = await retrieveOpenPrUrl(ctx, repo.full_name);
    if (prUrl) {
      return { outcome: 'skip', reason: 'PR_ALREADY_OPEN', prUrl };
    }
    try {
      await ctx.github.deleteBranch(repo.full_name, CI_BRANCH);
    } catch (error) {
      if (await ctx.github.getBranch(repo.full_name, CI_BRANCH)) {
        throw error;
      }
    }
  }
  try {
    await ctx.github.createBranch(repo.full_name, CI_BRANCH, baseSha);
  } catch (error) {
    const branch = await ctx.github.getBranch(repo.full_name, CI_BRANCH);
    if (branch?.object.sha !== baseSha) {
      throw error;
    }
  }
  return undefined;
}

export async function executeRepo(
  ctx: ProcessRepoContext,
  repo: GitHubRepo,
  bindings: ReadonlyMap<string, string>,
): Promise<ExecuteResult> {
  try {
    // Refresh eligibility and render against the current default branch before replacing any branch.
    repo = await ctx.github.getRepository(repo.full_name);
    const assessment = await assessRepo(ctx, repo, bindings);
    if (assessment.outcome !== 'proceed') {
      return assessment;
    }
    const { projectKey, workflow, title, body } = assessment;
    const base = await ctx.github.getBranch(repo.full_name, repo.default_branch);
    if (!base) {
      throw new CommandFailedError(`Default branch '${repo.default_branch}' is missing.`);
    }
    const branchResult = await prepareOnboardingBranch(ctx, repo, base.object.sha);
    if (branchResult) {
      return branchResult;
    }
    try {
      await ctx.github.createFile(repo.full_name, WORKFLOW_PATH, CI_BRANCH, workflow, title);
    } catch (error) {
      if (
        (await ctx.github.getFileContent(repo.full_name, WORKFLOW_PATH, CI_BRANCH)) !== workflow
      ) {
        throw error;
      }
    }
    let prUrl: string;
    try {
      prUrl = await ctx.github.createPullRequest(
        repo.full_name,
        CI_BRANCH,
        repo.default_branch,
        title,
        body,
      );
    } catch (error) {
      const existing = await retrieveOpenPrUrl(ctx, repo.full_name);
      if (!existing) {
        throw error;
      }
      prUrl = existing;
    }
    return { outcome: 'opened', projectKey, prUrl };
  } catch (error) {
    return failure(error);
  }
}
