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
import { AGENT_ACTIVITY_PATH, AI_REMEDIATION_DOCS_URL } from '../../../lib/config-constants';
import logger from '../../../lib/logger';
import { discoverProject } from '../../../lib/project-workspace';
import type { SonarQubeIssue } from '../../../lib/types';
import { SonarQubeClient } from '../../../sonarqube/client';
import { IssuesClient } from '../../../sonarqube/issues';
import { MAX_PAGE_SIZE } from '../../../sonarqube/projects';
import { blank, info, multiSelectPrompt, print, success, withSpinner } from '../../../ui';
import { cyan, dim, red, yellow } from '../../../ui/colors';
import { CommandFailedError, InvalidOptionError } from '../_common/error';

export interface RemediateOptions {
  project?: string;
  issues?: string;
}

const SEVERITY_ORDER = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'] as const;

const SEVERITY_COLORS: Record<string, (s: string) => string> = {
  BLOCKER: red,
  CRITICAL: red,
  MAJOR: yellow,
  MINOR: cyan,
  INFO: dim,
};

// Mirrors MULTISELECT_MAX_SELECTED in src/ui/components/prompts.ts. Kept local
// to avoid coupling the command surface to a UI implementation constant.
const MAX_REMEDIATION_ISSUES = 20;

export async function remediate(options: RemediateOptions, auth: ResolvedAuth): Promise<void> {
  // Pure validation first (no I/O): catches malformed --issues with zero round-trips.
  const suppliedIssueKeys =
    options.issues === undefined ? undefined : parseIssueKeys(options.issues);

  if (auth.connectionType !== 'cloud') {
    throw new CommandFailedError(
      'sonar remediate requires SonarQube Cloud - The Remediation Agent is not supported on SonarQube Server.',
    );
  }

  if (
    !process.stdin.isTTY &&
    !process.env.SONARQUBE_CLI_MOCK_TTY &&
    suppliedIssueKeys === undefined
  ) {
    throw new CommandFailedError(
      "Non-interactive mode requires --issues <issueIds>. Run 'sonar list issues --project <key>' to find issue keys.",
    );
  }

  const client = new SonarQubeClient(auth.serverUrl, auth.token);

  // resolveAuth guarantees orgKey is set for cloud connections (see auth-resolver.ts);
  // narrow once and reuse throughout this function.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const orgKey = auth.orgKey!;

  const { status: entitlement } = await client.checkAiRemediationEntitlement(orgKey);
  if (entitlement === 'not_eligible') {
    print(`The Remediation Agent is not available for your organization (${orgKey}).`);
    print(`Learn more: ${AI_REMEDIATION_DOCS_URL}`);
    blank();
    throw new CommandFailedError('Remediation Agent unavailable');
  }
  if (entitlement === 'not_enabled') {
    print(`The Remediation Agent is not enabled for your organization (${orgKey}).`);
    print(`Learn more: ${AI_REMEDIATION_DOCS_URL}`);
    blank();
    throw new CommandFailedError('Remediation Agent unavailable');
  }
  if (entitlement === 'unknown') {
    print(
      'Could not verify Remediation Agent entitlement. Please try again or contact support if the issue persists.',
    );
    blank();
    throw new CommandFailedError('Remediation Agent unavailable');
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

  let selectedKeys: string[];
  if (suppliedIssueKeys === undefined) {
    const interactive = await selectIssuesInteractively(client, orgKey, projectKey);
    if (interactive === null) return;
    selectedKeys = interactive;
  } else {
    selectedKeys = suppliedIssueKeys;
  }

  // The AI agent API requires the project's legacy component ID, not its key.
  const resolvedId = await client.getComponentId(projectKey);
  logger.debug(`getComponentId(${projectKey}) => ${resolvedId ?? 'null (falling back to key)'}`);
  const projectId = resolvedId ?? projectKey;

  blank();
  const jobRequest = { projectId, issueKeys: selectedKeys, triggerSource: 'CLI' as const };
  logger.debug(`scheduleAgentJob request: ${JSON.stringify(jobRequest)}`);
  let taskId: string;
  try {
    const response = await withSpinner('Submitting remediation job', () =>
      client.scheduleAgentJob(jobRequest),
    );
    taskId = response.taskId;
  } catch (err) {
    logger.error(`scheduleAgentJob failed: ${(err as Error).message}`);
    const lines = mapErrorMessage((err as Error).message, orgKey);
    throw new CommandFailedError(`Remediation job submission failed.\n  ${lines.join('\n  ')}`);
  }

  const issueWord = selectedKeys.length === 1 ? 'issue' : 'issues';
  blank();
  success(`Submitted ${selectedKeys.length} ${issueWord} for remediation\nJob: job/${taskId}`);
  blank();
  const activityUrl = `${auth.serverUrl}${AGENT_ACTIVITY_PATH}?id=${encodeURIComponent(projectKey)}`;
  info(
    `The agent will create pull requests for the selected issues. Track progress:\n${activityUrl}`,
  );
}

async function fetchEligibleIssues(
  issuesClient: IssuesClient,
  orgKey: string | undefined,
  projectKey: string,
): Promise<SonarQubeIssue[]> {
  // We intentionally fetch a single page of up to MAX_PAGE_SIZE eligible issues:
  // larger result sets are overwhelming in an interactive multi-select without
  // additional filtering. Users can re-run the command after resolving some.
  const result = await issuesClient.searchIssues({
    projects: projectKey,
    organization: orgKey,
    issueStatuses: 'OPEN,CONFIRMED',
    fixableByAgent: true,
    ps: MAX_PAGE_SIZE,
    p: 1,
  });
  return result.issues;
}

function parseIssueKeys(raw: string): string[] {
  const trimmed = raw.split(',').map((k) => k.trim());
  if (trimmed.some((k) => k.length === 0)) {
    throw new InvalidOptionError(
      `Invalid --issues option: '${raw}'. Empty entries are not allowed.`,
    );
  }
  const deduped = Array.from(new Set(trimmed));
  if (deduped.length > MAX_REMEDIATION_ISSUES) {
    throw new InvalidOptionError(
      `--issues accepts at most ${MAX_REMEDIATION_ISSUES} issue keys (got ${deduped.length}).`,
    );
  }
  return deduped;
}

// Returns null when no eligible issues exist or the user dismisses the prompt;
// the user-facing message is already printed in those branches.
async function selectIssuesInteractively(
  client: SonarQubeClient,
  orgKey: string,
  projectKey: string,
): Promise<string[] | null> {
  const issuesClient = new IssuesClient(client);

  const issues = await withSpinner(`Fetching eligible issues for ${projectKey}`, () =>
    fetchEligibleIssues(issuesClient, orgKey, projectKey),
  );
  if (issues.length > 0) {
    print(`  ${issues.length} eligible issues found`);
  }

  if (issues.length === 0) {
    blank();
    info(
      'No eligible issues found. The agent may not support the languages or rules in this project.',
    );
    return null;
  }

  const sorted = [...issues].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );

  blank();
  const selection = await multiSelectPrompt(
    'Which issues should the agent fix?',
    sorted.map((issue) => ({
      value: issue.key,
      label: formatIssueLabel(issue, projectKey),
    })),
  );

  if (!selection || selection.length === 0) {
    blank();
    print('No issues selected.');
    return null;
  }
  return selection;
}

function formatIssueLabel(issue: SonarQubeIssue, projectKey: string): string {
  const severityColor = SEVERITY_COLORS[issue.severity] ?? dim;
  const severity = severityColor(issue.severity.padEnd(8));
  const rule = dim(issue.rule);
  const path = issue.component.replace(`${projectKey}:`, '');
  const messageIndent = '         ';
  return `${severity}  ${rule}  ${path}\n${messageIndent}${issue.message}`;
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
