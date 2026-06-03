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

// Consolidated opening sequence for integrate commands

import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import type { DiscoveredProject } from '../../../../lib/project-workspace';
import { SonarQubeClient } from '../../../../sonarqube/client';
import type { PhaseItem, StepStatus } from '../../../../ui';
import { phase, phaseItem, warn, withSpinner } from '../../../../ui';
import { CommandFailedError } from '../../_common/error';
import { GitRepo } from '../../_common/git-repo';
import { checkTokenStatus, type TokenStatus } from '../../_common/token';

export async function discoverProjectWithSpinner<T>(discover: () => Promise<T>): Promise<T> {
  return withSpinner('Discovering project...', discover);
}

export function warnAuthProjectMismatches(auth: ResolvedAuth, project: DiscoveredProject): void {
  if (auth.serverUrl && project.serverUrl && auth.serverUrl !== project.serverUrl) {
    warn(
      'Detected a Server URL mismatch between the current project configuration and the auth logged in configuration. If this is not intended please consider running "sonar auth logout" and re-run the integrate command',
    );
  }

  if (auth.orgKey && project.organization && auth.orgKey !== project.organization) {
    warn(
      'Detected an organization mismatch between the current project configuration and the auth logged in configuration. If this is not intended please consider running "sonar auth logout" and re-run the integrate command',
    );
  }
}

export interface AgentSetupSummaryOptions {
  serverUrl: string;
  organization?: string;
  token: string;
  project: DiscoveredProject;
  projectKey?: string;
  /** When set, the project key was taken from `--project` rather than a config file. */
  cliProjectKey?: string;
}

export async function printAgentSetupSummary(options: AgentSetupSummaryOptions): Promise<void> {
  const tokenStatus = await checkTokenStatus(options.serverUrl, options.token);
  phase('Connection', await buildConnectionItems(options, tokenStatus));
  phase('Project', await buildProjectItems(options, tokenStatus));

  if (tokenStatus !== 'valid') {
    throw new CommandFailedError(
      tokenStatus === 'invalid' ? 'Token is invalid.' : 'Server is unreachable.',
      {
        remediationHint:
          "Run 'sonar auth logout' and then 'sonar auth login' to obtain a fresh token.",
      },
    );
  }
}

async function buildConnectionItems(
  options: AgentSetupSummaryOptions,
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
  options: AgentSetupSummaryOptions,
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

function buildConfigSourceItem(options: AgentSetupSummaryOptions): PhaseItem {
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

export async function printGitRepositorySummary(gitRoot: string): Promise<void> {
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
