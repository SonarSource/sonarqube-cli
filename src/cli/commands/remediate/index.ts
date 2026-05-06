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

// Remediate command - triggers AI agent remediation for eligible issues

import type { ResolvedAuth } from '../../../lib/auth-resolver';
import logger from '../../../lib/logger';
import { discoverProject } from '../../../lib/project-workspace';
import type { SonarQubeIssue } from '../../../lib/types';
import { SonarQubeClient } from '../../../sonarqube/client';
import { IssuesClient } from '../../../sonarqube/issues';
import { MAX_PAGE_SIZE } from '../../../sonarqube/projects';
import { blank, multiSelectPrompt, print } from '../../../ui';
import { cyan, dim, green, red, yellow } from '../../../ui/colors';
import { CommandFailedError } from '../_common/error';

export interface RemediateOptions {
  project?: string;
}

const SEVERITY_ORDER = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'] as const;

const AI_REMEDIATION_DOCS_URL =
  'https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/ai-features/sonarqube-remediation-agent';

const SEVERITY_COLORS: Record<string, (s: string) => string> = {
  BLOCKER: red,
  CRITICAL: red,
  MAJOR: yellow,
  MINOR: cyan,
  INFO: dim,
};

export async function remediate(options: RemediateOptions, auth: ResolvedAuth): Promise<void> {
  if (auth.connectionType !== 'cloud') {
    throw new CommandFailedError(
      'sonar remediate requires SonarQube Cloud - The Remediation Agent is not supported on SonarQube Server.',
    );
  }

  const client = new SonarQubeClient(auth.serverUrl, auth.token);

  if (!auth.orgKey) {
    throw new CommandFailedError('Cannot verify the Remediation Agent entitlements.');
  }
  const { status: entitlement } = await client.checkAiRemediationEntitlement(auth.orgKey);
  if (entitlement === 'not_eligible') {
    print(`The Remediation Agent is not available for your organization (${auth.orgKey}).`);
    print(`Learn more: ${AI_REMEDIATION_DOCS_URL}`);
    blank();
    throw new CommandFailedError('The Remediation Agent is not available for this organization.');
  }
  if (entitlement === 'not_enabled') {
    print(`The Remediation Agent is not enabled for your organization (${auth.orgKey}).`);
    print(`Learn more: ${AI_REMEDIATION_DOCS_URL}`);
    blank();
    throw new CommandFailedError('The Remediation Agent is not available for this organization.');
  }
  if (entitlement === 'unknown') {
    print(
      'Could not verify Remediation Agent entitlement. Please try again or contact support if the issue persists.',
    );
    blank();
    throw new CommandFailedError('Unable to verify Remediation Agent entitlement.');
  }

  let projectKey = options.project;
  if (!projectKey) {
    const discovered = await discoverProject(process.cwd());
    projectKey = discovered.projectKey;
  }
  if (!projectKey) {
    throw new CommandFailedError(
      'Could not determine project key. Use --project <key> to specify it.',
    );
  }

  const issuesClient = new IssuesClient(client);

  // Step 1: Fetch eligible issues
  process.stdout.write(`  Fetching issues for project ${projectKey}...`);

  const issues = await fetchEligibleIssues(issuesClient, auth.orgKey, projectKey);

  process.stdout.write(`  ${green('✓')}  ${issues.length} eligible issues found\n`);

  if (issues.length === 0) {
    blank();
    print('0 jobs created · 0 issues queued');
    blank();
    print(
      'No eligible issues found. The agent may not support the languages or rules in this project.',
    );
    return;
  }

  // Step 2: Sort by severity descending (BLOCKER first)
  const sorted = [...issues].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );

  // Step 3: Interactive multi-selector
  blank();
  const selectedKeys = await multiSelectPrompt(
    'Which issues should the agent fix?',
    sorted.map((issue) => ({
      value: issue.key,
      label: formatIssueLabel(issue, projectKey),
    })),
  );

  if (!selectedKeys || selectedKeys.length === 0) {
    blank();
    print('No issues selected.');
    return;
  }

  // Step 4: Resolve the project's legacy ID (component.id) required by the AI agent API
  const resolvedId = await client.getComponentId(projectKey);
  logger.debug(`getComponentId(${projectKey}) => ${resolvedId ?? 'null (falling back to key)'}`);
  const projectId = resolvedId ?? projectKey;

  // Step 5: Submit one job with all selected issue keys
  blank();
  print(`Submitting 1 remediation job...`);

  const jobRequest = { projectId, issueKeys: selectedKeys, triggerSource: 'CLI' as const };
  logger.debug(`scheduleAgentJob request: ${JSON.stringify(jobRequest)}`);
  let taskId: string;
  try {
    const response = await client.scheduleAgentJob(jobRequest);
    taskId = response.taskId;
  } catch (err) {
    logger.error(`scheduleAgentJob failed: ${(err as Error).message}`);
    const lines = mapErrorMessage((err as Error).message, auth.orgKey);
    print(`  failed: ${lines[0]}`);
    for (let i = 1; i < lines.length; i++) {
      print(`    ${lines[i]}`);
    }
    blank();
    print(`0 jobs created · 0 issues queued · 1 job failed`);
    throw new CommandFailedError('Remediation job submission failed.');
  }

  const issueWord = selectedKeys.length === 1 ? 'issue' : 'issues';
  print(`  job/${taskId}  ·  ${selectedKeys.length} ${issueWord}  ·  submitted`);
  blank();
  print(`1 job created · ${selectedKeys.length} ${issueWord} queued · 0 skipped`);
  blank();
  const activityUrl = `${auth.serverUrl}/project/agent_activity?id=${projectKey}`;
  print('The agent will create pull requests for the selected issues. Track progress:');
  print(`  ${activityUrl}`);
}

async function fetchEligibleIssues(
  issuesClient: IssuesClient,
  orgKey: string | undefined,
  projectKey: string,
): Promise<SonarQubeIssue[]> {
  const result = await issuesClient.searchIssues({
    projects: projectKey,
    organization: orgKey,
    issueStatuses: 'OPEN,CONFIRMED',
    fixableByAgent: true,
    ps: MAX_PAGE_SIZE,
    p: 1, // One page is the intended behavior at the moment as it can be overwhelming to search for issues without additional filtering
  });
  return result.issues;
}

function formatIssueLabel(issue: SonarQubeIssue, projectKey: string): string {
  const severityColor = SEVERITY_COLORS[issue.severity] ?? dim;
  const severity = severityColor(issue.severity.padEnd(8));
  const maxRuleLineLength = 14;
  const rule = dim(issue.rule.padEnd(maxRuleLineLength));
  const path = issue.component.replace(`${projectKey}:`, '');
  const maxDescriptionLength = 50;
  const elispsisLength = 3;
  const msg =
    issue.message.length > maxDescriptionLength
      ? `${issue.message.slice(0, maxDescriptionLength - elispsisLength)}...`
      : issue.message;
  return `${severity}  ${rule}  ${path} - ${msg}`;
}

function mapErrorMessage(raw: string, displayOrg: string): string[] {
  if (raw.includes('Organization does not have allowance for AI agent jobs')) {
    return [
      `Your organization plan does not include the Remediation Agent (${displayOrg}).`,
      `Learn more: ${AI_REMEDIATION_DOCS_URL}`,
    ];
  }

  return [
    `The Remediation Agent is not enabled for your organization (${displayOrg}).`,
    `Learn more: ${AI_REMEDIATION_DOCS_URL}`,
  ];
}
