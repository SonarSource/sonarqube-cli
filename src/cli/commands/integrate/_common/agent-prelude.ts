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

// Shared opening sequence for agent integrate commands (claude, codex, copilot).

import { homedir } from 'node:os';

import { isSonarQubeCloud, type ResolvedAuth } from '../../../../lib/auth-resolver';
import { type DiscoveredProject, discoverProject } from '../../../../lib/project-workspace';
import type { IntegrationScope } from '../../../../lib/state';
import { intro, warn, withSpinner } from '../../../../ui';
import { CommandFailedError, InvalidOptionError } from '../../_common/error';
import { printAgentSetupSummary } from './setup-summary';
import type { IntegrateAgentOptions } from './types';

export type AgentIntegrateSubcommand = 'claude' | 'codex' | 'copilot';

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

export async function discoverIntegrateProject(): Promise<DiscoveredProject> {
  return withSpinner('Discovering project...', () => discoverProject(process.cwd()));
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
 * Shared opening for all agent integrate commands: scope validation, intro,
 * project discovery, mismatch warnings, missing project-key notice, cloud org
 * check, and Connection/Project setup summary (including token validation).
 */
export async function runAgentIntegratePrelude(
  agentDisplayName: string,
  subcommand: AgentIntegrateSubcommand,
  options: IntegrateAgentOptions,
  auth: ResolvedAuth,
): Promise<AgentIntegrateContext> {
  assertIntegrateScopeOptions(options);
  introAgentIntegration(agentDisplayName);
  const project = await discoverIntegrateProject();
  warnAuthProjectMismatches(auth, project);
  const ctx = buildAgentIntegrateContext(options, auth, project);
  warnMissingIntegrateProjectKey(subcommand, ctx.isGlobal, ctx.projectKey);
  assertSonarCloudOrganization(ctx.serverUrl, ctx.organization);
  await printAgentSetupSummary({
    serverUrl: ctx.serverUrl,
    organization: ctx.organization,
    token: ctx.token,
    project: ctx.project,
    projectKey: ctx.projectKey,
    cliProjectKey: options.project,
  });
  return ctx;
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

export function warnGlobalSqaaRequiresProject(subcommand: AgentIntegrateSubcommand): void {
  warn(
    `SonarQube Agentic Analysis is project-scoped and is not enabled by this global install. Run \`sonar integrate ${subcommand} --project <key>\` from a project directory to enable it for that project.`,
  );
}
