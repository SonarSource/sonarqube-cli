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

import { isSonarQubeCloud, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { type DiscoveredProject, discoverProject } from '@/core/project-info.ts';
import type { IntegrationScope } from '@/core/state/state.ts';
import type { Console } from '@/core/ui/console.ts';

import { printAgentPreflightSummary } from './preflight-summary.ts';

export interface AgentIntegrateContext {
  project: DiscoveredProject;
  projectKey: string | undefined;
  serverUrl: string;
  organization: string | undefined;
  token: string;
}

export function introAgentIntegration(agentDisplayName: string, console: Console): void {
  console.intro(`SonarQube Integration Setup for ${agentDisplayName}`);
}

export async function discoverIntegrateProject(
  auth: ResolvedAuth,
  console: Console,
): Promise<DiscoveredProject> {
  return console.withSpinner('Discovering project...', () =>
    discoverProject(process.cwd(), { auth, silent: true, console }),
  );
}

export function warnAuthProjectMismatches(
  auth: ResolvedAuth,
  project: DiscoveredProject,
  console: Console,
): void {
  if (auth.serverUrl && project.serverUrl && auth.serverUrl !== project.serverUrl) {
    console.warn(
      'Detected a Server URL mismatch between the current project configuration and the auth logged in configuration. If this is not intended please consider running "sonar auth logout" and re-run the integrate command',
    );
  }

  if (auth.orgKey && project.organization && auth.orgKey !== project.organization) {
    console.warn(
      'Detected an organization mismatch between the current project configuration and the auth logged in configuration. If this is not intended please consider running "sonar auth logout" and re-run the integrate command',
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
  auth: ResolvedAuth,
  project: DiscoveredProject,
): AgentIntegrateContext {
  return {
    project,
    projectKey: project.projectKey,
    serverUrl: auth.serverUrl,
    organization: auth.orgKey,
    token: auth.token,
  };
}

/**
 * Shared preflight for all agent integrate commands: intro, project discovery,
 * mismatch warnings, cloud org check, then the Connection/Project preflight
 * summary (including token validation). Every agent integration installs
 * globally.
 */
export async function displayAgentIntegratePrelude(
  agentDisplayName: string,
  auth: ResolvedAuth,
  console: Console,
): Promise<AgentIntegrateContext> {
  introAgentIntegration(agentDisplayName, console);
  const project = await discoverIntegrateProject(auth, console);
  warnAuthProjectMismatches(auth, project, console);
  assertSonarCloudOrganization(auth.serverUrl, auth.orgKey);
  await printAgentPreflightSummary(
    {
      serverUrl: auth.serverUrl,
      organization: auth.orgKey,
      token: auth.token,
      project,
      projectKey: project.projectKey,
    },
    console,
  );
  return buildAgentIntegrateContext(auth, project);
}

/** Every agent integration installs to the user's home directory. */
export function resolveIntegrateInstallTarget(): {
  installRoot: string;
  installScope: IntegrationScope;
} {
  return { installRoot: homedir(), installScope: 'global' };
}
