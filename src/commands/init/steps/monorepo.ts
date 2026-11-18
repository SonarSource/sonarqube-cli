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

import { InvalidOptionError, remediationHintFor } from '@/core/commands/command-error.ts';
import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import { findGitRoot, getGitRemote } from '@/core/host/git/discover.ts';
import { pathComparisonKey } from '@/core/io/fs-utils.ts';
import { relativeProjectPath, resolveProjectTarget } from '@/core/project-discovery/link-target.ts';
import type { CompleteProjectMapping } from '@/core/project-discovery/project-discovery-result.ts';
import { discoverProjects } from '@/core/project-discovery/project-info.ts';
import {
  resolveContainedPath,
  sharedProjectConfigRepository,
} from '@/core/project-discovery/shared-project-config.ts';
import { stripGitRemoteUrlUserinfo } from '@/core/server/git-remote-url.ts';
import { ProjectsClient } from '@/core/server/projects.ts';
import type { Console } from '@/core/ui/console.ts';

import type { InitOutcome, MonorepoRootResult } from '../init-outcome.ts';
import { generateProjectProposal } from '../key-proposal.ts';
import type { MonorepoRootOption } from '../options.ts';
import type { DetectDeps } from './detect.ts';
import {
  findLinkedProjectIssues,
  isRunFatal,
  type LinkedProjectIssue,
  type LinkedProjectProblem,
  reportLinkedProjectIssues,
} from './linked-projects.ts';
import { linkCommand, writeMapping } from './mapping.ts';
import { runUnboundNew } from './unbound.ts';

/** Where a mapped root stands against the active connection, before anything runs for it. */
type RootStatus =
  /** The directory is linked in `.sonar-config.json` and the remote has the project: nothing to do. */
  | { kind: 'configured' }
  /** The file links the directory, but the remote cannot confirm the project. Never created. */
  | { kind: 'unavailable'; problem: LinkedProjectProblem }
  /** `--root` names a key whose project exists in the active organization, but the file does not map it. */
  | { kind: 'existing' }
  /** No project has the mapped key yet. */
  | { kind: 'new' }
  | { kind: 'other-org' }
  /** `--root` names a key, but the file already maps that directory to another project. */
  | { kind: 'conflict'; recordedKey: string }
  /** The lookup failed for this root only. */
  | { kind: 'unchecked'; reason: string };

type OnboardableStatus = Exclude<
  RootStatus,
  { kind: 'configured' | 'unavailable' | 'unchecked' | 'conflict' }
>;

interface MonorepoRoot {
  mapping: CompleteProjectMapping;
  /** Relative to the repository root, for display and the summary. */
  path: string;
  status: RootStatus;
  /** The git remote the keys were generated from, so a created project is named from the same input. */
  remote?: string;
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
      return { kind: 'existing' };
  }
}

/** A root the file links is only checked, never created: a project the remote lacks is reported. */
async function classifyLinkedRoot(
  mapping: CompleteProjectMapping,
  path: string,
  deps: DetectDeps,
): Promise<RootStatus> {
  const issue = (
    await findLinkedProjectIssues([{ projectKey: mapping.projectKey, path }], deps)
  ).at(0);
  return issue === undefined
    ? { kind: 'configured' }
    : { kind: 'unavailable', problem: issue.problem };
}

/**
 * A `--root` mapping carries the active connection, so the file, not the mapping, tells whether the
 * directory is already linked. A directory the file links to this key is checked like any other
 * linked root, so naming it again never creates its project.
 */
async function classifyExplicitRoot(
  mapping: CompleteProjectMapping,
  repositoryRoot: string,
  path: string,
  deps: DetectDeps,
): Promise<RootStatus> {
  const recorded = (await sharedProjectConfigRepository.load(repositoryRoot)).find(
    ({ projectRoot }) => projectRoot === mapping.projectRoot,
  );
  if (recorded === undefined) {
    return classifyRoot(mapping, deps);
  }
  return recorded.projectKey === mapping.projectKey
    ? classifyLinkedRoot(mapping, path, deps)
    : { kind: 'conflict', recordedKey: recorded.projectKey };
}

/** Roots read from the file are checked on the remote; roots named with `--root` may also be created or mapped. */
async function inspectRoot(
  mapping: CompleteProjectMapping,
  repositoryRoot: string,
  deps: DetectDeps,
  explicit: boolean,
): Promise<MonorepoRoot> {
  const path = relativeProjectPath(repositoryRoot, mapping.projectRoot);
  if (!explicit) {
    return { mapping, path, status: await classifyLinkedRoot(mapping, path, deps) };
  }
  try {
    return {
      mapping,
      path,
      status: await classifyExplicitRoot(mapping, repositoryRoot, path, deps),
    };
  } catch (error) {
    if (isRunFatal(error)) {
      throw error;
    }
    return { mapping, path, status: { kind: 'unchecked', reason: describeFailure(error) } };
  }
}

async function mapExistingRoot(
  { mapping, path }: MonorepoRoot,
  { auth, console }: DetectDeps,
): Promise<MonorepoRootResult> {
  await writeMapping(auth, mapping.projectKey, mapping.projectRoot, console, 'found', true);
  console.success(`Mapped ${path} to project '${mapping.projectKey}'.`);
  return { path, kind: 'linked', projectKey: mapping.projectKey };
}

async function createRootProject(
  { mapping, path, remote }: MonorepoRoot,
  deps: DetectDeps,
): Promise<MonorepoRootResult> {
  const outcome = await runUnboundNew(
    { path: 'unbound-new', projectRoot: mapping.projectRoot, remote },
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

async function onboardRoot(root: MonorepoRoot, deps: DetectDeps): Promise<MonorepoRootResult> {
  const { path, mapping, status } = root;
  if (status.kind === 'configured') {
    return {
      path,
      kind: 'configured',
      projectKey: mapping.projectKey,
      serverUrl: mapping.serverUrl,
    };
  }
  if (status.kind === 'unavailable') {
    return { path, kind: 'unavailable', projectKey: mapping.projectKey, problem: status.problem };
  }
  if (status.kind === 'unchecked') {
    return { path, kind: 'failed', reason: status.reason };
  }
  if (status.kind === 'conflict') {
    return {
      path,
      kind: 'conflict',
      projectKey: mapping.projectKey,
      recordedKey: status.recordedKey,
    };
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
 * Reports the project roots that `.sonar-config.json` maps as configured, and onboards the ones named
 * with `--root`, each on its own path. A root's mapping is merged into the file as soon as that root
 * completes, so what finished stays in place when a later root fails or the run stops, and a rerun
 * skips it. The roots run one after the other because each may prompt.
 */
export async function runMonorepo(
  projectRoot: string,
  deps: DetectDeps,
  explicitRoots: readonly MonorepoRootOption[] = [],
): Promise<InitOutcome> {
  const { console } = deps;
  const explicit = explicitRoots.length > 0;
  const { mappings, repositoryRoot, configDir, generatedKeys, remote } = explicit
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
    Promise.all(
      mappings.map(async (mapping) => ({
        ...(await inspectRoot(mapping, repositoryRoot, deps, explicit)),
        remote,
      })),
    ),
  );
  reportRootProblems(roots, deps);
  return { kind: 'monorepo', roots: await onboardInOrder(roots, deps) };
}

/** Said before any root is onboarded, while the user can still stop: these roots are left as they are. */
function reportRootProblems(roots: readonly MonorepoRoot[], { auth, console }: DetectDeps): void {
  const issues: LinkedProjectIssue[] = [];
  for (const { path, mapping, status } of roots) {
    if (status.kind === 'conflict') {
      console.warn(
        `${path} is already mapped to '${status.recordedKey}' in ${SHARED_PROJECT_CONFIG_FILE_NAME}, not '${mapping.projectKey}', so it was left as it is. Remap it with '${linkCommand(mapping.projectKey, path, undefined, true)}'.`,
      );
    } else if (status.kind === 'unavailable') {
      issues.push({ projectKey: mapping.projectKey, path, problem: status.problem });
    }
  }
  reportLinkedProjectIssues(issues, auth, console);
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
  /** Credential-free git remote of the repository; only read for `--root` roots. */
  remote?: string;
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
  const rawRemote = isGit ? await getGitRemote(gitRoot) : '';
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
  return { mappings, repositoryRoot: targetDir, generatedKeys, remote };
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
  deps: DetectDeps,
): Promise<MonorepoRootResult[]> {
  return roots.reduce<Promise<MonorepoRootResult[]>>(async (previous, root) => {
    const results = await previous;
    results.push(await onboardRoot(root, deps));
    return results;
  }, Promise.resolve([]));
}
