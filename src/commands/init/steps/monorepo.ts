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

import { join } from 'node:path';

import { authMatchesRecordedConnection } from '@/core/auth/recorded-connection.ts';
import { InvalidOptionError, remediationHintFor } from '@/core/commands/command-error.ts';
import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import { ProjectOrganizationError } from '@/core/errors.ts';
import { findGitRoot, getGitRemote } from '@/core/host/git/discover.ts';
import { pathComparisonKey } from '@/core/io/fs-utils.ts';
import { relativeProjectPath, resolveProjectTarget } from '@/core/project-discovery/link-target.ts';
import type { CompleteProjectMapping } from '@/core/project-discovery/project-discovery-result.ts';
import { discoverProjects } from '@/core/project-discovery/project-info.ts';
import {
  resolveContainedPath,
  sharedProjectConfigRepository,
} from '@/core/project-discovery/shared-project-config.ts';
import { UnexpectedApiError } from '@/core/server/errors.ts';
import { stripGitRemoteUrlUserinfo } from '@/core/server/git-remote-url.ts';
import { HTTP_STATUS_UNAUTHORIZED } from '@/core/server/http-constants.ts';
import { ProjectsClient } from '@/core/server/projects.ts';
import type { Console } from '@/core/ui/console.ts';

import { OnboardingCancelledError, requireAnswer } from '../answer.ts';
import type { InitOutcome, MonorepoRootResult } from '../init-outcome.ts';
import { generateProjectProposal } from '../key-proposal.ts';
import type { MonorepoRootOption } from '../options.ts';
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
  /** `--root` names a key, but the file already maps that directory to another project. */
  | { kind: 'conflict'; recordedKey: string }
  /** The lookup failed for this root only. */
  | { kind: 'unchecked'; reason: string };

type OnboardableStatus = Exclude<RootStatus, { kind: 'configured' | 'unchecked' | 'conflict' }>;

interface MonorepoRoot {
  mapping: CompleteProjectMapping;
  /** Relative to the repository root, for display and the summary. */
  path: string;
  status: RootStatus;
  /** Named with `--root`, so the user already chose the key and is not asked to confirm it. */
  explicit: boolean;
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

/**
 * A `--root` mapping carries the active connection, so on its own it would pass for recorded: the
 * file, not the mapping, tells whether the directory is already linked to this project.
 */
async function classifyExplicitRoot(
  mapping: CompleteProjectMapping,
  repositoryRoot: string,
  deps: DetectDeps,
): Promise<RootStatus> {
  const recorded = (await sharedProjectConfigRepository.load(repositoryRoot)).find(
    ({ projectRoot }) => projectRoot === mapping.projectRoot,
  );
  if (recorded && recorded.projectKey !== mapping.projectKey) {
    return { kind: 'conflict', recordedKey: recorded.projectKey };
  }
  const status = await classifyRoot(mapping, deps);
  const linked = recorded !== undefined && authMatchesRecordedConnection(deps.auth, recorded);
  return status.kind === 'configured' && !linked ? { kind: 'existing' } : status;
}

async function inspectRoot(
  mapping: CompleteProjectMapping,
  repositoryRoot: string,
  deps: DetectDeps,
  explicit: boolean,
): Promise<MonorepoRoot> {
  const path = relativeProjectPath(repositoryRoot, mapping.projectRoot);
  try {
    const status = explicit
      ? await classifyExplicitRoot(mapping, repositoryRoot, deps)
      : await classifyRoot(mapping, deps);
    return { mapping, path, status, explicit };
  } catch (error) {
    if (isRunFatal(error)) {
      throw error;
    }
    return {
      mapping,
      path,
      status: { kind: 'unchecked', reason: describeFailure(error) },
      explicit,
    };
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
    case 'conflict':
      return `already mapped to '${status.recordedKey}'`;
    case 'unchecked':
      return `could not be checked (${status.reason.split('\n')[0]})`;
  }
}

function describeRoot({ path, mapping, status }: MonorepoRoot): string {
  return `${path} (${mapping.projectKey}): ${describeStatus(status)}`;
}

function needsOnboarding(root: MonorepoRoot): boolean {
  const { kind } = root.status;
  return kind !== 'configured' && kind !== 'unchecked' && kind !== 'conflict';
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
  { mapping, path, explicit }: MonorepoRoot,
  { auth, console }: DetectDeps,
): Promise<MonorepoRootResult> {
  const recorded = mapping.organization ?? mapping.serverUrl;
  const confirmed =
    explicit ||
    requireAnswer(
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
  if (status.kind === 'conflict') {
    return {
      path,
      kind: 'failed',
      reason: `${path} is already mapped to '${status.recordedKey}' in ${SHARED_PROJECT_CONFIG_FILE_NAME}, not '${mapping.projectKey}'. Remap it with 'sonar link --monorepo ${mapping.projectKey} --path ${path}'.`,
    };
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
 * Plain `sonar init` meets a `.sonar-config.json` that maps several usable roots: offers to onboard
 * them as a monorepo. The file is the one `runMonorepo` would use. A single link keeps the usual
 * path, as it may be a project in a subfolder; `--monorepo` continues an unfinished monorepo.
 */
export async function offerMonorepo(projectRoot: string, deps: DetectDeps): Promise<boolean> {
  const { auth, console } = deps;
  const discovered = await discoverProjects(projectRoot, {
    auth,
    console,
    silent: true,
    useKnownMappings: false,
    useGitRemoteBinding: false,
  });
  if (!discovered.fromSharedConfig || discovered.projects.length < 2) {
    return false;
  }
  return requireAnswer(
    await console.confirmPrompt(
      `${SHARED_PROJECT_CONFIG_FILE_NAME} already maps project roots. Onboard it as a monorepo instead?`,
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
export async function runMonorepo(
  projectRoot: string,
  deps: DetectDeps,
  explicitRoots: readonly MonorepoRootOption[] = [],
): Promise<InitOutcome> {
  const { console } = deps;
  const explicit = explicitRoots.length > 0;
  const { mappings, repositoryRoot, configDir, generatedKeys } = explicit
    ? await mapExplicitRoots(projectRoot, explicitRoots, deps)
    : await discoverMappedRoots(projectRoot, deps);
  if (mappings.length === 0) {
    return { kind: 'no-monorepo-roots' };
  }

  warnOnNestedConfig(configDir, repositoryRoot, console);
  generatedKeys?.forEach(({ path, projectKey }) => {
    console.print(`Generated project key for ${path}: ${projectKey}`);
  });
  const roots = await console.withSpinner('Checking the mapped project roots', () =>
    Promise.all(mappings.map((mapping) => inspectRoot(mapping, repositoryRoot, deps, explicit))),
  );
  // Roots named on the command line are all wanted, and may run without a terminal.
  const selected = explicit
    ? new Set(roots.filter(needsOnboarding))
    : await selectRoots(roots, console);

  return { kind: 'monorepo', roots: await onboardInOrder(roots, selected, deps) };
}

interface GeneratedKey {
  path: string;
  projectKey: string;
}

interface MappedRoots {
  mappings: CompleteProjectMapping[];
  repositoryRoot: string;
  /** Where the roots were read from, when that is not the repository root. */
  configDir?: string;
  /** Roots named without a key, with the one generated for each. */
  generatedKeys?: GeneratedKey[];
}

async function discoverMappedRoots(projectRoot: string, deps: DetectDeps): Promise<MappedRoots> {
  const { auth, console } = deps;
  const discovered = await discoverProjects(projectRoot, {
    auth,
    console,
    silent: true,
    useKnownMappings: false,
    useGitRemoteBinding: false,
  });
  return {
    mappings: discovered.fromSharedConfig ? discovered.projects : [],
    repositoryRoot: discovered.repoRoot ?? projectRoot,
    configDir: discovered.configDir,
  };
}

/**
 * The key of a root named without one: the one `.sonar-config.json` already records for the
 * directory, else the one `init` generates for it, which clones of the repository agree on.
 */
function keyForUnkeyedRoot(
  root: string,
  recorded: readonly CompleteProjectMapping[],
  remote: string | undefined,
  auth: DetectDeps['auth'],
): { projectKey: string; generated: boolean } {
  const known = recorded.find(({ projectRoot }) => projectRoot === root);
  return known
    ? { projectKey: known.projectKey, generated: false }
    : {
        projectKey: generateProjectProposal(root, remote, auth.orgKey).projectKey,
        generated: true,
      };
}

/** Turns `--root` values into mappings on the active connection, before any root is touched. */
async function mapExplicitRoots(
  projectRoot: string,
  explicitRoots: readonly MonorepoRootOption[],
  { auth }: DetectDeps,
): Promise<MappedRoots> {
  const { targetDir } = await resolveProjectTarget(projectRoot);
  const needsKey = explicitRoots.some(({ projectKey }) => projectKey === undefined);
  const recorded = needsKey ? await sharedProjectConfigRepository.load(targetDir) : [];
  const { gitRoot, isGit } = findGitRoot(targetDir);
  const rawRemote = needsKey && isGit ? await getGitRemote(gitRoot) : '';
  const remote = rawRemote ? stripGitRemoteUrlUserinfo(rawRemote) : undefined;

  const generatedKeys: GeneratedKey[] = [];
  const mappings = explicitRoots.map(({ path, projectKey }) => {
    const resolved = resolveContainedPath(targetDir, path);
    if (resolved === null) {
      throw new InvalidOptionError(
        `--root path "${path}" must point to an existing directory inside ${targetDir}.`,
      );
    }
    const key =
      projectKey === undefined
        ? keyForUnkeyedRoot(resolved, recorded, remote, auth)
        : { projectKey, generated: false };
    if (key.generated) {
      generatedKeys.push({ path, projectKey: key.projectKey });
    }
    return {
      projectRoot: resolved,
      projectKey: key.projectKey,
      serverUrl: auth.serverUrl,
      organization: auth.orgKey,
    };
  });
  const repeated = mappings.find(
    ({ projectKey }, index) =>
      mappings.findIndex((other) => other.projectKey === projectKey) !== index,
  );
  if (repeated) {
    throw new InvalidOptionError(
      `--root resolves more than one directory to project '${repeated.projectKey}'.`,
      'Name a different key for one of them with --root <path>=<project key>.',
    );
  }
  return { mappings, repositoryRoot: targetDir, generatedKeys };
}

/** Mappings are always saved at the repository root, so a nested or main-worktree file stays as it is. */
function warnOnNestedConfig(
  configDir: string | undefined,
  repositoryRoot: string,
  console: Console,
): void {
  if (
    configDir === undefined ||
    pathComparisonKey(configDir) === pathComparisonKey(repositoryRoot)
  ) {
    return;
  }
  console.warn(
    `The project roots come from ${join(configDir, SHARED_PROJECT_CONFIG_FILE_NAME)}, but their mappings will be saved to the ${SHARED_PROJECT_CONFIG_FILE_NAME} at the repository root (${repositoryRoot}).`,
  );
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
