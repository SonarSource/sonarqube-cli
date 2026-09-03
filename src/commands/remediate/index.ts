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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import {
  AGENT_ACTIVITY_PATH,
  AGENTIC_PACK_URL,
  AI_REMEDIATION_DOCS_URL,
} from '@/core/config-constants.ts';
import logger from '@/core/observability/logger.ts';
import { discoverProject } from '@/core/project-info.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { type IssuesClient } from '@/core/server/issues.ts';
import { MAX_PAGE_SIZE } from '@/core/server/projects.ts';
import type { SonarQubeIssue } from '@/core/server/types.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import { blank, info, multiSelectPrompt, print, success, withSpinner } from '@/core/ui';
import { cyan, dim, red, yellow } from '@/core/ui/colors.ts';
import { printAgentNonInteractiveAlternativeHint } from '@/core/ui/components/agent-prompt-hint.ts';

import { RemediateApiClient } from './remediate-api.ts';

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

// Mirrors MULTISELECT_MAX_SELECTED in src/core/ui/components/prompts.ts. Kept local
// to avoid coupling the command surface to a UI implementation constant.
const MAX_REMEDIATION_ISSUES = 20;

export async function remediate(
  options: RemediateOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { auth } = ctx;
  // Pure validation first (no I/O): catches malformed --issues with zero round-trips.
  const suppliedIssueKeys =
    options.issues === undefined ? undefined : parseIssueKeys(options.issues);

  if (suppliedIssueKeys === undefined) {
    printAgentNonInteractiveAlternativeHint('sonar remediate --issues <issue-key-1>,<issue-key-2>');
  }

  assertCloudConnection(auth);
  assertInteractiveOrIssuesSupplied(suppliedIssueKeys);

  const client = new RemediateApiClient(new SonarHttpClient(auth.serverUrl, auth.token));
  // resolveAuth guarantees orgKey is set for cloud connections (see auth-resolver.ts);
  // narrow once and reuse throughout this function.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const orgKey = auth.orgKey!;

  if (!(await confirmEntitlement(client, orgKey))) return;

  const projectKey = await resolveProjectKey(options, auth);
  noteProject(auth, projectKey);
  const selectedKeys =
    suppliedIssueKeys ?? (await selectIssuesInteractively(client, orgKey, projectKey));
  if (selectedKeys === null) return;

  const projectId = await resolveProjectId(client, projectKey);
  const taskId = await submitRemediationJob(client, projectId, selectedKeys, orgKey);
  reportSubmissionSuccess(auth, projectKey, selectedKeys, taskId);
}

function assertCloudConnection(auth: ResolvedAuth): void {
  if (auth.connectionType !== 'cloud') {
    throw new CommandFailedError('sonar remediate requires a SonarQube Cloud connection.', {
      remediationHint: "Authenticate against SonarQube Cloud with 'sonar auth login' and retry.",
    });
  }
}

function assertInteractiveOrIssuesSupplied(suppliedIssueKeys: string[] | undefined): void {
  const canPrompt = process.stdin.isTTY || Boolean(process.env.SONARQUBE_CLI_MOCK_TTY);
  if (!canPrompt && suppliedIssueKeys === undefined) {
    throw new CommandFailedError('Non-interactive mode requires --issues <issueIds>.', {
      remediationHint:
        "Run 'sonar list issues --project <key>' to find issue keys, then pass them with --issues.",
    });
  }
}

/**
 * Prints the applicable message and returns false when remediation is not
 * available for this organisation. Throws when entitlement could not be verified.
 */
async function confirmEntitlement(client: RemediateApiClient, orgKey: string): Promise<boolean> {
  const { status: entitlement } = await client.checkAiRemediationEntitlement(orgKey);
  if (entitlement === 'not_eligible') {
    blank();
    info(`The Remediation Agent is not available for your organisation. See ${AGENTIC_PACK_URL}`);
    return false;
  }
  if (entitlement === 'not_enabled') {
    blank();
    info(
      `The Remediation Agent is not enabled for your organisation. Contact your admin to enable it.`,
    );
    return false;
  }
  if (entitlement === 'unknown') {
    throw new CommandFailedError('Remediation Agent unavailable.', {
      remediationHint:
        'Could not verify Remediation Agent entitlement. Retry later, and report to https://github.com/SonarSource/sonarqube-cli/issues if the problem persists.',
    });
  }
  return true;
}

async function resolveProjectKey(options: RemediateOptions, auth: ResolvedAuth): Promise<string> {
  if (options.project) {
    return options.project;
  }
  const discovered = await discoverProject(process.cwd(), { auth });
  if (!discovered.projectKey) {
    throw new CommandFailedError('Could not determine project key.', {
      remediationHint: 'Use --project <key> to specify it.',
    });
  }
  return discovered.projectKey;
}

// The AI agent API requires the project's legacy component ID, not its key.
async function resolveProjectId(client: RemediateApiClient, projectKey: string): Promise<string> {
  const resolvedId = await client.components.getComponentId(projectKey);
  logger.debug(`getComponentId(${projectKey}) => ${resolvedId ?? 'null (falling back to key)'}`);
  return resolvedId ?? projectKey;
}

async function submitRemediationJob(
  client: RemediateApiClient,
  projectId: string,
  issueKeys: string[],
  orgKey: string,
): Promise<string> {
  blank();
  const jobRequest = { projectId, issueKeys, triggerSource: 'CLI' as const };
  logger.debug(`scheduleAgentJob request: ${JSON.stringify(jobRequest)}`);
  try {
    const response = await withSpinner('Submitting remediation job', () =>
      client.scheduleAgentJob(jobRequest),
    );
    return response.taskId;
  } catch (err) {
    logger.error(`scheduleAgentJob failed: ${(err as Error).message}`);
    throw new CommandFailedError('Remediation job submission failed.', {
      cause: err,
      remediationHint: mapSubmissionFailureHint((err as Error).message, orgKey),
    });
  }
}

function reportSubmissionSuccess(
  auth: ResolvedAuth,
  projectKey: string,
  selectedKeys: string[],
  taskId: string,
): void {
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
  client: RemediateApiClient,
  orgKey: string,
  projectKey: string,
): Promise<string[] | null> {
  const issuesClient = client.issues;

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

function mapSubmissionFailureHint(raw: string, displayOrg: string): string {
  if (raw.includes('Organization does not have allowance for AI agent jobs')) {
    return `Your organization plan does not include the Remediation Agent (${displayOrg}). Learn more: ${AI_REMEDIATION_DOCS_URL}`;
  }

  return `The Remediation Agent is not enabled for your organization (${displayOrg}). Learn more: ${AI_REMEDIATION_DOCS_URL}`;
}
