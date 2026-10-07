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

import { isSonarQubeCloud } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { OnboardingProgress } from '@/core/commands/onboarding-progress.ts';
import { pollUntil, waitDeadline } from '@/core/commands/poll.ts';
import { CloudOnboardingClient } from '@/core/server/cloud-onboarding.ts';

export interface ProjectWaitOptions {
  project?: string;
  repo?: string;
  timeout: number;
  format: string;
  events?: boolean;
}

async function resolveProject(
  options: ProjectWaitOptions,
  ctx: CommandAuthenticatedInvocationContext,
  client: CloudOnboardingClient,
): Promise<string> {
  if (options.project?.trim()) return options.project;
  if (!ctx.auth.orgKey)
    throw new CommandFailedError('Select an organization with sonar org import first.');
  const { repositories } = await client.repositories(ctx.auth.orgKey).orThrow();
  const repository = repositories.find(
    (repo) =>
      (repo.slug ?? repo.installationKey.split('|')[0]).toLowerCase() ===
      options.repo?.toLowerCase(),
  );
  if (repository?.linkedProjects.length !== 1)
    throw new CommandFailedError(
      'Repository must be imported and linked to exactly one project. Use --project for monorepos.',
    );
  return repository.linkedProjects[0].key;
}

export async function projectWait(
  options: ProjectWaitOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { auth, console } = ctx;
  if (!isSonarQubeCloud(auth.serverUrl))
    throw new CommandFailedError('Project wait is only supported on SonarQube Cloud.');
  if (Boolean(options.project?.trim()) === Boolean(options.repo?.trim()))
    throw new InvalidOptionError('Pass exactly one of --project or --repo.');
  const progress = new OnboardingProgress(console, options.events);
  progress.start('analysis', 'Checking your project analysis. No action is needed from you.');
  try {
    await waitForAnalysis(options, ctx, progress);
  } catch (error) {
    progress.fail(
      'Analysis could not be confirmed. Return to your agent to check project setup or resume waiting.',
    );
    throw error;
  }
}

async function waitForAnalysis(
  options: ProjectWaitOptions,
  ctx: CommandAuthenticatedInvocationContext,
  progress: OnboardingProgress,
): Promise<void> {
  const { auth, console } = ctx;
  const deadline = waitDeadline(options.timeout);
  const client = new CloudOnboardingClient(ctx.connection.httpClient);
  const project = await resolveProject(options, ctx, client);
  console.info(`Waiting for completed analysis of '${project}'.`, 'stderr');
  const analysis = await pollUntil(
    async () => {
      const { analyses } = await client.completedAnalyses(project).orThrow();
      const completed = analyses.at(0);
      if (completed) return completed;
      const eligibility = await client.eligibility(project).orThrow();
      if (eligibility?.eligible === false)
        throw new CommandFailedError(
          `Automatic analysis is unavailable: ${eligibility.ineligibilityReason ?? 'repository is ineligible'}. Configure CI analysis for '${project}', then rerun this command.`,
        );
      return undefined;
    },
    deadline,
    `Timed out waiting for analysis of '${project}'. Project remains imported; rerun this command to resume.`,
  );
  progress.complete(
    'analysis',
    'Your project analysis is complete. Your agent can now review the findings.',
  );
  const result = {
    projectKey: project,
    analysisId: analysis.key,
    analysisDate: analysis.date,
    url: `${auth.serverUrl}/dashboard?id=${encodeURIComponent(project)}`,
  };
  if (options.format === 'json') console.print(JSON.stringify(result));
  else console.success(`Analysis completed: ${result.url}`);
}
