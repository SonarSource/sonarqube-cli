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

// Shared preflight opening for agent integrate commands (claude, codex, copilot).

import { homedir } from 'node:os';

import { isSonarQubeCloud, type ResolvedAuth } from '../../../../lib/auth-resolver';
import { type DiscoveredProject, discoverProject } from '../../../../lib/project-workspace';
import type { IntegrationScope } from '../../../../lib/state';
import { intro, warn, withSpinner } from '../../../../ui';
import { CommandFailedError, InvalidOptionError } from '../../_common/error';
import { isGlobalIntegrateScope, resolveIntegrateScope } from './integrate-scope';
import { printAgentPreflightSummary } from './preflight-summary';
import type { IntegrateAgentOptions } from './types';

export type AgentIntegrateSubcommand = 'antigravity' | 'claude' | 'codex' | 'copilot' | 'cursor';

export interface AgentIntegrateContext {
  project: DiscoveredProject;
  isGlobal: boolean;
  projectKey: string | undefined;
  serverUrl: string;
  organization: string | undefined;
  token: string;
}

/** Rejects `--global` combined with `--project`. */
export function assertIntegrateScopeOptions(options: IntegrateAgentOptions): void {
  if (options.global && options.project) {
    throw new InvalidOptionError(
      '--global and --project are mutually exclusive; please specify only one scope.',
    );
  }
}

export function introAgentIntegration(agentDisplayName: string): void {
  intro(`SonarQube Integration Setup for ${agentDisplayName}`);
}

export async function discoverIntegrateProject(auth: ResolvedAuth): Promise<DiscoveredProject> {
  return withSpinner('Discovering project...', () =>
    discoverProject(process.cwd(), true, { auth }),
  );
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

export function warnMissingIntegrateProjectKey(
  subcommand: AgentIntegrateSubcommand,
  isGlobal: boolean,
  projectKey: string | undefined,
): void {
  if (!isGlobal && !projectKey) {
    warn(
      `No project key provided - project related actions will be skipped. Run \`sonar integrate ${subcommand} --help\` for ways to define a project.`,
    );
  }
}

export function assertSonarCloudOrganization(
  serverUrl: string,
  organization: string | undefined,
): void {
  if (isSonarQubeCloud(serverUrl) && !organization) {
    throw new CommandFailedError('SonarQube Cloud requires an organization.', {
      remediationHint: "Run 'sonar auth login' with a SonarQube Cloud organization.",
    });
  }
}

export function buildAgentIntegrateContext(
  options: IntegrateAgentOptions,
  auth: ResolvedAuth,
  project: DiscoveredProject,
): AgentIntegrateContext {
  return {
    project,
    isGlobal: options.global ?? false,
    projectKey: options.project || project.projectKey,
    serverUrl: auth.serverUrl,
    organization: auth.orgKey,
    token: auth.token,
  };
}

/**
 * Shared preflight for all agent integrate commands: scope validation, intro,
 * project discovery, mismatch warnings, cloud org check, Connection/Project
 * preflight summary (including token validation), then install-scope selection.
 */
export async function displayAgentIntegratePrelude(
  agentDisplayName: string,
  subcommand: AgentIntegrateSubcommand,
  options: IntegrateAgentOptions,
  auth: ResolvedAuth,
): Promise<AgentIntegrateContext> {
  assertIntegrateScopeOptions(options);
  introAgentIntegration(agentDisplayName);
  const project = await discoverIntegrateProject(auth);
  warnAuthProjectMismatches(auth, project);
  const projectKey = options.project || project.projectKey;
  assertSonarCloudOrganization(auth.serverUrl, auth.orgKey);
  await printAgentPreflightSummary({
    serverUrl: auth.serverUrl,
    organization: auth.orgKey,
    token: auth.token,
    project,
    projectKey,
    cliProjectKey: options.project,
  });
  const scope = await resolveIntegrateScope({
    ...options,
    projectRoot: project.rootDir,
    projectKey: options.project,
  });
  const isGlobal = isGlobalIntegrateScope(scope);
  warnMissingIntegrateProjectKey(subcommand, isGlobal, projectKey);
  return buildAgentIntegrateContext({ ...options, global: isGlobal }, auth, project);
}

export function resolveIntegrateInstallTarget(
  isGlobal: boolean,
  projectRoot: string,
): { installRoot: string; installScope: IntegrationScope } {
  return {
    installRoot: isGlobal ? homedir() : projectRoot,
    installScope: isGlobal ? 'global' : 'project',
  };
}
