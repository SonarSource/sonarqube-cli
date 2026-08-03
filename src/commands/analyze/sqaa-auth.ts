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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import { selectRecordedFeatureForDir } from '@/core/host/recorded-feature-resolver.ts';
import logger from '@/core/observability/logger.ts';
import type { InstalledIntegrationFeature, IntegrationStateAttribute } from '@/core/state/state.ts';
import { loadState } from '@/core/state/state-repository.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import { blank, confirmPrompt, text, warn } from '@/core/ui';
import { printAgentNonInteractiveAlternativeHint } from '@/core/ui/components/agent-prompt-hint.ts';

import { SQAA_HOOK_FEATURE_ID } from '../integrate/_common/features/sqaa-instructions-feature.ts';
import { isProjectVortexFeature } from '../integrate/_common/vortex.ts';

function isProjectSqaaFeature(feature: InstalledIntegrationFeature): boolean {
  return (
    isProjectVortexFeature(feature) ||
    (feature.featureId === SQAA_HOOK_FEATURE_ID && feature.scope === 'project')
  );
}

function getOptionalStringAttr(
  attrs: Record<string, IntegrationStateAttribute> | undefined,
  key: string,
): string | undefined {
  const value = attrs?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const LARGE_CHANGESET_HINT =
  'For faster feedback, try targeting your changes:\n' +
  '  --staged          analyze only staged files\n' +
  '  --base <ref>      analyze files changed vs a branch (e.g. --base main)\n' +
  '  --file <path>     analyze specific file(s) — repeat for multiple files\n' +
  '  --depth STANDARD  faster analysis (change-set / multi-file default is DEEP)';

/** Cloud authentication context required for SQAA API calls. */
export interface CloudAuth {
  serverUrl: string;
  token: string;
  orgKey: string;
}

/**
 * Outcome of resolving cloud auth + project key for SQAA. This resolver reports
 * what it found and leaves the policy (skip vs. fail) to the caller:
 * - `resolved`: usable cloud auth and project key.
 * - `no-cloud`: connection is not SonarQube Cloud (a warning was already emitted,
 *   since agentic analysis is Cloud-only and this is always a graceful skip).
 * - `no-project`: cloud auth is fine but no project is configured. The caller
 *   decides whether this is an error or a graceful skip.
 */
export type SqaaAuthResolution =
  | { kind: 'resolved'; cloudAuth: CloudAuth; projectKey: string }
  | { kind: 'no-cloud' }
  | { kind: 'no-project' };

/**
 * Combines cloud-auth validation and project-key resolution. Never throws or warns for
 * `no-project` — the caller owns that decision (see `resolveSqaaContext` in sqaa.ts).
 *
 * Not side-effect-free: on a successful resolution it publishes the project key for
 * `project_uuid` telemetry (see `noteProject`). This is the single choke point for every SQAA
 * entry point — bare `sonar analyze`, `analyze agentic`, and `verify` — so noting here covers
 * all of them instead of at each of the five downstream call sites.
 */
export async function resolveCloudAuthAndProject(
  auth: ResolvedAuth,
  explicitProject: string | undefined,
  projectRoot?: string,
): Promise<SqaaAuthResolution> {
  const cloudAuth = resolveCloudAuth(auth, explicitProject);
  if (!cloudAuth) return { kind: 'no-cloud' };

  const projectKey = explicitProject ?? (await resolveSqaaProjectKey(projectRoot));
  if (!projectKey) return { kind: 'no-project' };

  noteProject(auth, projectKey);
  return { kind: 'resolved', cloudAuth, projectKey };
}

/**
 * Validate that the resolved auth is for SonarQube Cloud.
 * Returns null when the connection is not Cloud and --project is not set.
 * Throws CommandFailedError when --project is set but the connection is not Cloud.
 */
export function resolveCloudAuth(
  auth: ResolvedAuth,
  explicitProject: string | undefined,
): CloudAuth | null {
  if (auth.connectionType != 'cloud' || auth.orgKey == null) {
    if (explicitProject) {
      throw new CommandFailedError('Vortex analysis requires a SonarQube Cloud connection.', {
        remediationHint: "Run 'sonar auth login' and connect to SonarQube Cloud, then retry.",
      });
    }
    warn(
      'Vortex analysis skipped: a SonarQube Cloud connection is required. Run: sonar auth login (ensure you connect to SonarQube Cloud)',
    );
    return null;
  }

  return { serverUrl: auth.serverUrl, token: auth.token, orgKey: auth.orgKey };
}

/**
 * Look up the project key for the current project from the declarative
 * integration state (`integrations.installed`).
 *
 * Delegates the worktree-aware matching to the shared resolver (see
 * `selectRecordedFeatureForDir`): the current directory is mapped to its working
 * tree — and, from a linked worktree, to the main working tree — then matched
 * against the recorded Vortex features, preferring a `targetRoot` (physical
 * install dir) match over a `repoRoot`-only one. Falls back to `process.cwd()`
 * when no `projectRoot` is given so the single-file path still works, including
 * from a subdirectory or outside git.
 */
export async function resolveSqaaProjectKey(projectRoot?: string): Promise<string | null> {
  try {
    const candidates = loadState().integrations.installed.flatMap((integration) =>
      integration.features.filter(isProjectSqaaFeature).map((feature) => ({
        feature,
        targetRoot: feature.targetRoot,
        repoRoot: getOptionalStringAttr(feature.attrs, 'repoRoot'),
        updatedAt: feature.updatedAt,
      })),
    );
    const sqaaFeature = await selectRecordedFeatureForDir(projectRoot ?? process.cwd(), candidates);

    const projectKey = sqaaFeature?.attrs?.projectKey;
    if (typeof projectKey !== 'string' || projectKey.length === 0) {
      logger.debug('Vortex analysis skipped: no project key found in integration state');
      return null;
    }

    return projectKey;
  } catch {
    logger.debug('Vortex analysis skipped: failed to resolve integration state');
    return null;
  }
}

/**
 * Warn about a large change set and ask the user to confirm.
 * In non-interactive contexts (no stdin TTY — e.g. CI/agent runs), prints a
 * warning and auto-proceeds. Returns false only when the user explicitly declines in an interactive terminal.
 */
export async function confirmLargeChangeset(fileCount: number): Promise<boolean> {
  blank();
  warn(
    `You are about to analyze a large number of files (${fileCount}). This may take longer to process.\n${LARGE_CHANGESET_HINT}`,
  );

  if (!process.stdin.isTTY && !process.env.SONARQUBE_CLI_MOCK_TTY) {
    return true;
  }

  blank();
  printAgentNonInteractiveAlternativeHint('sonar analyze --force');
  const confirmed = await confirmPrompt('Do you wish to proceed?', true);
  if (!confirmed) {
    blank();
    text('Analysis cancelled. Use --force to bypass the file count check.');
    return false;
  }
  return true;
}
