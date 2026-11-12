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

import { authMatchesRecordedConnection } from '@/core/auth/recorded-connection.ts';
import { remediationHintFor } from '@/core/commands/command-error.ts';
import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import { ProjectOrganizationError } from '@/core/errors.ts';
import { relativeProjectPath, resolveConfigDir } from '@/core/project-discovery/link-target.ts';
import type { CompleteProjectMapping } from '@/core/project-discovery/project-discovery-result.ts';
import { discoverProjects } from '@/core/project-discovery/project-info.ts';
import { sharedProjectConfigFile } from '@/core/project-discovery/shared-project-config.ts';
import { UnexpectedApiError } from '@/core/server/errors.ts';
import { HTTP_STATUS_UNAUTHORIZED } from '@/core/server/http-constants.ts';
import { ProjectsClient } from '@/core/server/projects.ts';
import type { Console } from '@/core/ui/console.ts';

import { OnboardingCancelledError, requireAnswer } from '../answer.ts';
import type { InitOutcome, MonorepoRootResult } from '../init-outcome.ts';
import type { DetectDeps } from './detect.ts';
import { writeMapping } from './mapping.ts';
import { runUnboundNew } from './unbound.ts';

/** Where a mapped root stands against the active connection, before anything runs for it. */
type RootStatus =
  /** The mapping matches the active connection and the project exists: nothing to do. */
  | { kind: 'configured' }
  /** The project exists in the active organization, but the mapping records another connection. */
  | { kind: 'existing' }
  /** No project has the mapped key yet. */
  | { kind: 'new' }
  | { kind: 'other-org' }
  /** The lookup failed for this root only. */
  | { kind: 'unchecked'; reason: string };

type OnboardableStatus = Exclude<RootStatus, { kind: 'configured' | 'unchecked' }>;

interface MonorepoRoot {
  mapping: CompleteProjectMapping;
  /** Relative to the repository root, for display and the summary. */
  path: string;
  status: RootStatus;
}

/** What no later root can recover from: the answer to a prompt is gone, or the credentials or organization are wrong. */
function isRunFatal(error: unknown): boolean {
  return (
    error instanceof OnboardingCancelledError ||
    error instanceof ProjectOrganizationError ||
    (error instanceof UnexpectedApiError && error.status === HTTP_STATUS_UNAUTHORIZED)
  );
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unexpected failure.';
  const hint = remediationHintFor(error);
  return hint ? `${message}\n${hint}` : message;
}

async function classifyRoot(
  mapping: CompleteProjectMapping,
  { auth, http }: DetectDeps,
): Promise<RootStatus> {
  const lookup = await new ProjectsClient(http)
    .lookupProject(mapping.projectKey, auth.orgKey)
    .orThrow();
  switch (lookup.kind) {
    case 'missing':
      return { kind: 'new' };
    case 'other-org':
      return { kind: 'other-org' };
    case 'in-org':
      return authMatchesRecordedConnection(auth, mapping)
        ? { kind: 'configured' }
        : { kind: 'existing' };
  }
}

async function inspectRoot(
  mapping: CompleteProjectMapping,
  repositoryRoot: string,
  deps: DetectDeps,
): Promise<MonorepoRoot> {
  const path = relativeProjectPath(repositoryRoot, mapping.projectRoot);
  try {
    return { mapping, path, status: await classifyRoot(mapping, deps) };
  } catch (error) {
    if (isRunFatal(error)) {
      throw error;
    }
    return { mapping, path, status: { kind: 'unchecked', reason: describeFailure(error) } };
  }
}

function describeStatus(status: RootStatus): string {
  switch (status.kind) {
    case 'configured':
      return 'already configured';
    case 'existing':
      return 'project exists, mapping needs updating';
    case 'new':
      return 'project does not exist yet';
    case 'other-org':
      return 'belongs to another organization';
    case 'unchecked':
      return `could not be checked (${status.reason.split('\n')[0]})`;
  }
}

function describeRoot({ path, mapping, status }: MonorepoRoot): string {
  return `${path} (${mapping.projectKey}): ${describeStatus(status)}`;
}

function needsOnboarding(root: MonorepoRoot): boolean {
  return root.status.kind !== 'configured' && root.status.kind !== 'unchecked';
}

/** Shows every root with its status and lets the user pick which of those that need work to onboard. */
async function selectRoots(
  roots: readonly MonorepoRoot[],
  console: Console,
): Promise<ReadonlySet<MonorepoRoot>> {
  if (!roots.some(needsOnboarding)) {
    console.print('Mapped project roots:');
    roots.forEach((root) => {
      console.print(`  ${describeRoot(root)}`);
    });
    return new Set();
  }
  const picked = requireAnswer(
    await console.multiSelectPrompt(
      'Select the project roots to onboard (space toggles, enter confirms)',
      roots.map((root) => ({
        value: root,
        label: describeRoot(root),
        disabled: !needsOnboarding(root),
      })),
      { maxSelected: Infinity },
    ),
  );
  return new Set(picked);
}

async function mapExistingRoot(
  { mapping, path }: MonorepoRoot,
  { auth, console }: DetectDeps,
): Promise<MonorepoRootResult> {
  const recorded = mapping.organization ?? mapping.serverUrl;
  const confirmed = requireAnswer(
    await console.confirmPrompt(
      `Project '${mapping.projectKey}' already exists. Replace the connection recorded for ${path} in ${SHARED_PROJECT_CONFIG_FILE_NAME} (${recorded}) with the active one?`,
      true,
    ),
  );
  if (!confirmed) {
    return { path, kind: 'skipped' };
  }
  await writeMapping(auth, mapping.projectKey, mapping.projectRoot, console, 'found', true);
  console.success(`Mapped ${path} to project '${mapping.projectKey}'.`);
  return { path, kind: 'linked', projectKey: mapping.projectKey };
}

async function createRootProject(
  { mapping, path }: MonorepoRoot,
  deps: DetectDeps,
): Promise<MonorepoRootResult> {
  const outcome = await runUnboundNew(
    { path: 'unbound-new', projectRoot: mapping.projectRoot },
    deps,
    { projectKey: mapping.projectKey },
    true,
  );
  return outcome.kind === 'unbound'
    ? { path, kind: 'unbound', projectKey: outcome.projectKey }
    : { path, kind: 'skipped' };
}

function onboardSelectedRoot(
  root: MonorepoRoot,
  status: OnboardableStatus,
  deps: DetectDeps,
): Promise<MonorepoRootResult> {
  switch (status.kind) {
    case 'existing':
      return mapExistingRoot(root, deps);
    case 'new':
      return createRootProject(root, deps);
    case 'other-org': {
      const active = deps.auth.orgKey ?? 'the active one';
      return Promise.resolve({
        path: root.path,
        kind: 'failed',
        reason: `Project '${root.mapping.projectKey}' belongs to another organization than ${active}, or is not accessible with this token.`,
      });
    }
  }
}

async function onboardRoot(
  root: MonorepoRoot,
  selected: boolean,
  deps: DetectDeps,
): Promise<MonorepoRootResult> {
  const { path, mapping, status } = root;
  if (status.kind === 'configured') {
    return { path, kind: 'configured', projectKey: mapping.projectKey };
  }
  if (status.kind === 'unchecked') {
    return { path, kind: 'failed', reason: status.reason };
  }
  if (!selected) {
    return { path, kind: 'skipped' };
  }
  deps.console.print(`Onboarding ${path}`);
  try {
    return await onboardSelectedRoot(root, status, deps);
  } catch (error) {
    if (isRunFatal(error)) {
      throw error;
    }
    return { path, kind: 'failed', reason: describeFailure(error) };
  }
}

/**
 * Plain `sonar init` meets a `.sonar-config.json` that already maps several roots: offers to onboard
 * them as a monorepo. A single link keeps the usual path; `--monorepo` continues an unfinished one.
 */
export async function offerMonorepo(projectRoot: string, console: Console): Promise<boolean> {
  const { targetDir } = await resolveConfigDir(projectRoot);
  // Problems in the file are reported where it is read for good, as discovery does.
  const items = await sharedProjectConfigFile.readItems(targetDir, () => undefined);
  if (items.length < 2) {
    return false;
  }
  return requireAnswer(
    await console.confirmPrompt(
      `${SHARED_PROJECT_CONFIG_FILE_NAME} already maps several project roots. Onboard this as a monorepo instead?`,
      true,
    ),
  );
}

/**
 * Onboards the project roots that `.sonar-config.json` maps, each on its own path. A root's mapping
 * is merged into the file as soon as that root completes, so what finished stays in place when a
 * later root fails or the run stops, and a rerun picks up from there. The roots run one after the
 * other because each may prompt.
 */
export async function runMonorepo(projectRoot: string, deps: DetectDeps): Promise<InitOutcome> {
  const { auth, console } = deps;
  const discovered = await discoverProjects(projectRoot, {
    auth,
    console,
    silent: true,
    useKnownMappings: false,
    useGitRemoteBinding: false,
  });
  const mappings = discovered.fromSharedConfig ? discovered.projects : [];
  if (mappings.length === 0) {
    return { kind: 'no-monorepo-roots' };
  }

  const repositoryRoot = discovered.repoRoot ?? projectRoot;
  const roots = await console.withSpinner('Checking the mapped project roots', () =>
    Promise.all(mappings.map((mapping) => inspectRoot(mapping, repositoryRoot, deps))),
  );
  const selected = await selectRoots(roots, console);

  return { kind: 'monorepo', roots: await onboardInOrder(roots, selected, deps) };
}

/** One root finishes, prompts included, before the next starts. */
function onboardInOrder(
  roots: readonly MonorepoRoot[],
  selected: ReadonlySet<MonorepoRoot>,
  deps: DetectDeps,
): Promise<MonorepoRootResult[]> {
  return roots.reduce<Promise<MonorepoRootResult[]>>(async (previous, root) => {
    const results = await previous;
    results.push(await onboardRoot(root, selected.has(root), deps));
    return results;
  }, Promise.resolve([]));
}
