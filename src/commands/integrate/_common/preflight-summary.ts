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

// Preflight summaries shown at the start of integrate commands, before install.

import type { PhaseItem, StepStatus } from '../../../core/ui';
import { info, outro, phase, phaseItem, text } from '../../../core/ui';
import type { DiscoveredProject } from '../../../lib/project-workspace';
import { SonarQubeClient } from '../../../sonarqube/client.ts';
import { CommandFailedError } from '../../_common/error.ts';
import { GitRepo } from '../../_common/git-repo.ts';
import { checkTokenStatus, type TokenCheckResult, type TokenStatus } from '../../_common/token.ts';

export interface AgentPreflightSummaryOptions {
  serverUrl: string;
  organization?: string;
  token: string;
  project: DiscoveredProject;
  projectKey?: string;
  /** When set, the project key was taken from `--project` rather than a config file. */
  cliProjectKey?: string;
}

export async function printAgentPreflightSummary(
  options: AgentPreflightSummaryOptions,
): Promise<void> {
  const tokenResult: TokenCheckResult = await checkTokenStatus(options.serverUrl, options.token);
  const tokenStatus: TokenStatus = tokenResult.status;
  phase('Connection', await buildConnectionItems(options, tokenStatus));
  phase('Project', await buildProjectItems(options, tokenStatus));

  if (tokenStatus === 'unreachable') {
    reportUnreachableServerFailure();
    const message = tokenResult.errorMessage
      ? `Server is unreachable: ${tokenResult.errorMessage}`
      : 'Server is unreachable.';
    throw new CommandFailedError(message);
  }
  if (tokenStatus === 'invalid') {
    throw new CommandFailedError('Token is invalid.', {
      remediationHint: "Run 'sonar auth login' to obtain a fresh token.",
    });
  }
}

function reportUnreachableServerFailure(): void {
  outro('Setup failed', 'error');
  info('Server could not be reached.');
  text('   Ensure the URL is correct and check your network connection or SONAR_HOST_URL.');
}

async function buildConnectionItems(
  options: AgentPreflightSummaryOptions,
  tokenStatus: TokenStatus,
): Promise<PhaseItem[]> {
  const items: PhaseItem[] = [phaseItem('Server', 'done', options.serverUrl)];

  if (options.organization) {
    items.push(
      await buildOrganizationItem(
        options.organization,
        options.serverUrl,
        options.token,
        tokenStatus,
      ),
    );
  }

  const tokenDisplay = tokenDisplayForStatus(tokenStatus);
  items.push(phaseItem('Token', tokenDisplay.status, tokenDisplay.detail));
  return items;
}

async function buildOrganizationItem(
  organization: string,
  serverUrl: string,
  token: string,
  tokenStatus: TokenStatus,
): Promise<PhaseItem> {
  if (tokenStatus !== 'valid') {
    return phaseItem('Organization', 'done', organization);
  }

  const [status, detail] = await organizationAccessStatus(serverUrl, token, organization);
  return phaseItem('Organization', status, detail);
}

async function organizationAccessStatus(
  serverUrl: string,
  token: string,
  organization: string,
): Promise<[StepStatus, string | undefined]> {
  try {
    const client = new SonarQubeClient(serverUrl, token);
    const accessible = await client.checkOrganization(organization);
    return accessible ? ['done', organization] : ['failed', `${organization} (not accessible)`];
  } catch {
    return ['failed', `${organization} (not accessible)`];
  }
}

async function buildProjectItems(
  options: AgentPreflightSummaryOptions,
  tokenStatus: TokenStatus,
): Promise<PhaseItem[]> {
  const items: PhaseItem[] = [phaseItem('Root', 'done', options.project.rootDir)];

  if (options.project.isGitRepo) {
    items.push(phaseItem('Git repository', 'done', 'detected'));
  } else {
    items.push(phaseItem('Git repository', 'warn', 'not detected'));
  }

  if (options.projectKey) {
    items.push(
      await buildProjectKeyItem(options.projectKey, options.serverUrl, options.token, tokenStatus),
    );
  }

  items.push(buildConfigSourceItem(options));
  return items;
}

function buildConfigSourceItem(options: AgentPreflightSummaryOptions): PhaseItem {
  if (options.cliProjectKey) {
    return phaseItem('Config source', 'info', '--project');
  }

  if (options.project.configSources.length > 0) {
    return phaseItem('Config source', 'done', options.project.configSources.join(', '));
  }

  return phaseItem('Config source', 'warn', 'none detected');
}

async function buildProjectKeyItem(
  projectKey: string,
  serverUrl: string,
  token: string,
  tokenStatus: TokenStatus,
): Promise<PhaseItem> {
  if (tokenStatus !== 'valid') {
    return phaseItem('Key', 'done', projectKey);
  }

  const [status, detail] = await projectKeyAccessStatus(serverUrl, token, projectKey);
  return phaseItem('Key', status, detail);
}

async function projectKeyAccessStatus(
  serverUrl: string,
  token: string,
  projectKey: string,
): Promise<[StepStatus, string | undefined]> {
  try {
    const client = new SonarQubeClient(serverUrl, token);
    const accessible = await client.checkComponent(projectKey);
    return accessible ? ['done', projectKey] : ['failed', `${projectKey} (not accessible)`];
  } catch {
    return ['failed', `${projectKey} (not accessible)`];
  }
}

function tokenDisplayForStatus(tokenStatus: TokenStatus): {
  status: StepStatus;
  detail: string;
} {
  switch (tokenStatus) {
    case 'valid':
      return { status: 'done', detail: 'valid' };
    case 'invalid':
      return { status: 'failed', detail: 'invalid' };
    case 'unreachable':
      return { status: 'failed', detail: 'unreachable' };
  }
}

export async function printGitPreflightSummary(gitRoot: string): Promise<void> {
  const gitRepo = new GitRepo(gitRoot);
  const hooksDir = await gitRepo.getHooksDir();
  const framework = await resolveGitFrameworkLabel(gitRepo);

  phase('Repository', [
    phaseItem('Root', 'done', gitRoot),
    phaseItem('Git repository', 'done', 'detected'),
    phaseItem('Hooks directory', 'done', hooksDir),
    phaseItem('Framework', 'info', framework),
  ]);
}

async function resolveGitFrameworkLabel(gitRepo: GitRepo): Promise<string> {
  if (gitRepo.usesPreCommitFramework()) {
    return 'pre-commit';
  }
  if (await gitRepo.usesHusky()) {
    return 'husky';
  }
  return 'native git hooks';
}
