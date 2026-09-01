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

// Auth and project-key resolution for SQAA commands.

import { isSonarQubeCloud, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import logger from '@/core/observability/logger.ts';
import { discoverProject } from '@/core/project-info.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import { printAgentNonInteractiveAlternativeHint } from '@/core/ui/components/agent-prompt-hint.ts';
import type { Console } from '@/core/ui/console.ts';
import { TerminalConsole } from '@/core/ui/terminal-console.ts';
const LARGE_CHANGESET_HINT =
  'For faster feedback, try targeting your changes:\n' +
  '  --staged          analyze only staged files\n' +
  '  --base <ref>      analyze files changed vs a branch (e.g. --base main)\n' +
  '  --file <path>     analyze specific file(s) — repeat for multiple files\n' +
  '  --depth STANDARD  faster analysis (change-set / multi-file default is DEEP)';

/**
 * Authentication context required for SQAA API calls. `orgKey` is Cloud-only: Server has
 * no organizations and its A3S hub forces the request onto the instance's default one.
 */
export interface SqaaAuth {
  serverUrl: string;
  token: string;
  orgKey?: string;
}

/**
 * Outcome of resolving auth + project key for SQAA. This resolver reports
 * what it found and leaves the policy (skip vs. fail) to the caller:
 * - `resolved`: usable auth and project key.
 * - `no-org`: Cloud is authenticated but has no organization (a warning was already
 *   emitted, since this is always a graceful skip).
 * - `no-project`: auth is fine but no project is configured. The caller
 *   decides whether this is an error or a graceful skip.
 */
export type SqaaAuthResolution =
  | { kind: 'resolved'; sqaaAuth: SqaaAuth; projectKey: string }
  | { kind: 'no-org' }
  | { kind: 'no-project' };

/**
 * Combines auth validation and project-key resolution. Never throws or warns for
 * `no-project` — the caller owns that decision (see `resolveSqaaContext` in sqaa.ts).
 *
 * Not side-effect-free: on a successful resolution it publishes the project key for
 * `project_uuid` telemetry (see `noteProject`). This is the single choke point for every SQAA
 * entry point — bare `sonar analyze`, `analyze agentic`, and `verify` — so noting here covers
 * all of them instead of at each of the five downstream call sites.
 */
export async function resolveSqaaAuthAndProject(
  auth: ResolvedAuth,
  explicitProject: string | undefined,
  projectRoot?: string,
  console: Console = new TerminalConsole(),
): Promise<SqaaAuthResolution> {
  const sqaaAuth = resolveSqaaAuth(auth, explicitProject, console);
  if (!sqaaAuth) return { kind: 'no-org' };

  const projectKey = explicitProject ?? (await resolveSqaaProjectKey(auth, projectRoot, console));
  if (!projectKey) return { kind: 'no-project' };

  noteProject(auth, projectKey);
  return { kind: 'resolved', sqaaAuth, projectKey };
}

/**
 * Validate that the resolved auth can drive a Vortex analysis. Cloud needs an
 * organization to address; Server has none, so the connection alone is enough.
 *
 * Returns null when a Cloud connection has no organization and --project is not set.
 * Throws CommandFailedError when --project is set, since the caller asked explicitly.
 */
export function resolveSqaaAuth(
  auth: ResolvedAuth,
  explicitProject: string | undefined,
  console: Console = new TerminalConsole(),
): SqaaAuth | null {
  if (isSonarQubeCloud(auth.serverUrl) && !auth.orgKey) {
    if (explicitProject) {
      throw new CommandFailedError('Vortex analysis requires a SonarQube Cloud organization.', {
        remediationHint: "Run 'sonar auth login' and select an organization, then retry.",
      });
    }
    console.warn(
      'Vortex analysis skipped: a SonarQube Cloud organization is required. Run: sonar auth login',
    );
    return null;
  }

  return {
    serverUrl: auth.serverUrl,
    token: auth.token,
    ...(auth.orgKey ? { orgKey: auth.orgKey } : {}),
  };
}

/**
 * Look up the project key for the current project via the shared project-discovery
 * pipeline (`discoverProject`): the known-server-project-mapping cache, local config
 * files, then a git-remote-binding lookup against the server. Falls back to
 * `process.cwd()` when no `projectRoot` is given so the single-file path still
 * works, including from a subdirectory or outside git.
 */
export async function resolveSqaaProjectKey(
  auth: ResolvedAuth,
  projectRoot?: string,
  console: Console = new TerminalConsole(),
): Promise<string | null> {
  const discovered = await discoverProject(projectRoot ?? process.cwd(), {
    auth,
    silent: true,
    console,
  });
  if (!discovered.projectKey) {
    logger.debug('Vortex analysis skipped: no project key found');
  }
  return discovered.projectKey ?? null;
}

/**
 * Warn about a large change set and ask the user to confirm.
 * In non-interactive contexts (no stdin TTY — e.g. CI/agent runs), prints a
 * warning and auto-proceeds. Returns false only when the user explicitly declines in an interactive terminal.
 */
export async function confirmLargeChangeset(
  fileCount: number,
  console: Console = new TerminalConsole(),
): Promise<boolean> {
  console.blank();
  console.warn(
    `You are about to analyze a large number of files (${fileCount}). This may take longer to process.\n${LARGE_CHANGESET_HINT}`,
  );

  if (!process.stdin.isTTY && !process.env.SONARQUBE_CLI_MOCK_TTY) {
    return true;
  }

  console.blank();
  printAgentNonInteractiveAlternativeHint(console, 'sonar analyze --force');
  const confirmed = await console.confirmPrompt('Do you wish to proceed?', true);
  if (!confirmed) {
    console.blank();
    console.text('Analysis cancelled. Use --force to bypass the file count check.');
    return false;
  }
  return true;
}
