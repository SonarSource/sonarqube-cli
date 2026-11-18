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

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import { findGitRoot, getGitRemote } from '@/core/host/git/discover.ts';
import { pathComparisonKey } from '@/core/io/fs-utils.ts';
import { relativeProjectPath, resolveProjectTarget } from '@/core/project-discovery/link-target.ts';
import type { CompleteProjectMapping } from '@/core/project-discovery/project-discovery-result.ts';
import { discoverProjects } from '@/core/project-discovery/project-info.ts';
import {
  type ConfigItem,
  resolveContainedPath,
  sharedProjectConfigFile,
  sharedProjectConfigRepository,
  throwOnInvalidConfig,
} from '@/core/project-discovery/shared-project-config.ts';
import { stripGitRemoteUrlUserinfo } from '@/core/server/git-remote-url.ts';
import { ProjectsClient } from '@/core/server/projects.ts';
import type { Console } from '@/core/ui/console.ts';

import type { InitOutcome, MonorepoRootResult } from '../init-outcome.ts';
import { generateProjectProposal } from '../key-proposal.ts';
import type { MonorepoRootOption } from '../options.ts';
import type { DetectDeps } from './detect.ts';
import {
  describeFailure,
  findLinkedProjectIssues,
  isRunFatal,
  type LinkedProjectIssue,
  type LinkedProjectProblem,
  reportLinkedProjectIssues,
} from './linked-projects.ts';
import { linkCommand, writeMapping } from './mapping.ts';
import { type BindableRoot, bindNewRoots } from './monorepo-bind.ts';
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
  /** The key was guessed, not named by the user, so an existing project under it needs their say. */
  generated?: boolean;
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
  relinked: boolean,
): Promise<RootStatus> {
  const recorded = (await sharedProjectConfigRepository.load(repositoryRoot)).find(
    ({ projectRoot }) => projectRoot === mapping.projectRoot,
  );
  // A relink was asked for at the prompt, so the recorded key is replaced, not a conflict.
  if (recorded === undefined || relinked) {
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
  relinked: ReadonlySet<string>,
): Promise<MonorepoRoot> {
  const path = relativeProjectPath(repositoryRoot, mapping.projectRoot);
  if (!explicit) {
    return { mapping, path, status: await classifyLinkedRoot(mapping, path, deps) };
  }
  try {
    return {
      mapping,
      path,
      status: await classifyExplicitRoot(
        mapping,
        repositoryRoot,
        path,
        deps,
        relinked.has(mapping.projectRoot),
      ),
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
  { auth, console, dryRun }: DetectDeps,
): Promise<MonorepoRootResult> {
  if (dryRun) {
    return { path, kind: 'would-link', projectKey: mapping.projectKey };
  }
  await writeMapping(auth, mapping.projectKey, mapping.projectRoot, console, 'found', true);
  console.success(`Mapped ${path} to project '${mapping.projectKey}'.`);
  return { path, kind: 'linked', projectKey: mapping.projectKey };
}

/**
 * Runs the single-project creation flow for a root. A generated key is left to that flow, so a
 * project already under it is offered for linking, as for one directory, instead of being rejected
 * as a taken key; the flow then runs without `--bind`/`--create`, which refuse to touch it.
 */
async function createRootProject(
  { mapping, path, remote, generated }: MonorepoRoot,
  deps: DetectDeps,
): Promise<MonorepoRootResult> {
  // Without a terminal, naming the root with --root is the consent to create its project.
  const flowDeps: DetectDeps = deps.interactive
    ? { ...deps, intent: generated ? undefined : deps.intent }
    : { ...deps, intent: { kind: 'create' } };
  const outcome = await runUnboundNew(
    { path: 'unbound-new', projectRoot: mapping.projectRoot, remote },
    flowDeps,
    generated ? {} : { projectKey: mapping.projectKey },
    true,
  );
  if (outcome.kind === 'linked' || outcome.kind === 'unbound') {
    return { path, kind: outcome.kind, projectKey: outcome.projectKey };
  }
  if (outcome.kind === 'dry-run') {
    return outcome.action.type === 'link'
      ? { path, kind: 'would-link', projectKey: outcome.action.projectKey }
      : { path, kind: 'would-create', projectKey: mapping.projectKey };
  }
  return { path, kind: 'skipped' };
}

function onboardSelectedRoot(
  root: MonorepoRoot,
  status: OnboardableStatus,
  deps: DetectDeps,
  linkOnly: boolean,
): Promise<MonorepoRootResult> {
  switch (status.kind) {
    case 'existing':
      // A key the user named is consent to map it; one the CLI guessed is asked about, as for a single project.
      if (!root.generated || linkOnly) {
        return mapExistingRoot(root, deps);
      }
      return deps.interactive
        ? createRootProject(root, deps)
        : Promise.resolve({
            path: root.path,
            kind: 'failed',
            reason: `Project '${root.mapping.projectKey}' already exists, and nothing says whether ${root.path} belongs to it. Name it with --root ${root.path}=<project key> to map it.`,
          });
    case 'new':
      return linkOnly
        ? Promise.resolve({
            path: root.path,
            kind: 'failed',
            reason: `Project '${root.mapping.projectKey}' does not exist in ${deps.auth.orgKey ?? 'the active organization'}, and --link never creates one.`,
          })
        : createRootProject(root, deps);
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
  deps: DetectDeps,
  linkOnly: boolean,
  bound: ReadonlyMap<string, MonorepoRootResult>,
): Promise<MonorepoRootResult> {
  const { path, mapping, status } = root;
  const batched = bound.get(path);
  if (batched) {
    return batched;
  }
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
  deps.console.print(`${deps.dryRun ? 'Previewing' : 'Onboarding'} ${path}`);
  try {
    return await onboardSelectedRoot(root, status, deps, linkOnly);
  } catch (error) {
    if (isRunFatal(error)) {
      throw error;
    }
    return { path, kind: 'failed', reason: describeFailure(error) };
  }
}

/**
 * Reports the project roots that `.sonar-config.json` maps as configured, and onboards the ones named
 * with `--root`, each on its own path. The mapped roots that were not named are reported too, so a
 * run always shows every root the file maps. A root's mapping is merged into the file as soon as that root
 * completes, so what finished stays in place when a later root fails or the run stops, and a rerun
 * skips it. The roots run one after the other because each may prompt.
 */
export async function runMonorepo(
  projectRoot: string,
  deps: DetectDeps,
  explicitRoots: readonly MonorepoRootOption[] = [],
  linkOnly = false,
): Promise<InitOutcome> {
  const { console } = deps;
  const named =
    explicitRoots.length > 0
      ? await mapExplicitRoots(projectRoot, explicitRoots, deps, linkOnly)
      : undefined;
  // Read after the named roots are mapped, so the file's roots include them.
  const mapped = await discoverMappedRoots(projectRoot, deps);
  const { repositoryRoot, generatedKeys, relinked, remote, generatedRoots } = named ?? mapped;
  const configDir = named?.configDir ?? mapped.configDir;
  const namedRoots = new Set(
    (named?.mappings ?? []).map(({ projectRoot: root }) => pathComparisonKey(root)),
  );
  const mappings = [
    ...(named?.mappings ?? []),
    ...mapped.mappings.filter(({ projectRoot: root }) => !namedRoots.has(pathComparisonKey(root))),
  ];
  if (mappings.length === 0) {
    return { kind: 'no-monorepo-roots' };
  }

  warnOnNestedConfig(configDir, repositoryRoot, console);
  generatedKeys?.forEach(({ path, projectKey }) => {
    console.print(`Generated project key for ${path}: ${projectKey}`);
  });
  const roots = await console.withSpinner('Checking the mapped project roots', () =>
    Promise.all(
      mappings.map(async (mapping) => {
        const isNamed = namedRoots.has(pathComparisonKey(mapping.projectRoot));
        return {
          ...(await inspectRoot(mapping, repositoryRoot, deps, isNamed, relinked ?? new Set())),
          remote: isNamed ? remote : undefined,
          generated: generatedRoots?.has(pathComparisonKey(mapping.projectRoot)) ?? false,
        };
      }),
    ),
  );
  reportRootProblems(roots, deps);
  // `--link` never creates a project, and binding is a way of creating one.
  const bound = linkOnly ? new Map() : await bindNewRootsTogether(roots, repositoryRoot, deps);
  return { kind: 'monorepo', roots: await onboardInOrder(roots, deps, linkOnly, bound) };
}

/**
 * The roots that need a new project are bound to the repository in one call, asked once, before
 * any root runs. A root left out of it (the user declined, or the repository cannot be bound) is
 * created without binding by its own path afterwards.
 */
async function bindNewRootsTogether(
  roots: readonly MonorepoRoot[],
  repositoryRoot: string,
  deps: DetectDeps,
): Promise<Map<string, MonorepoRootResult>> {
  const newRoots = roots.filter(({ status }) => status.kind === 'new');
  if (newRoots.length === 0) {
    return new Map();
  }
  const { gitRoot, isGit } = findGitRoot(repositoryRoot);
  const rawRemote = isGit ? await getGitRemote(gitRoot) : '';
  const remote = rawRemote ? stripGitRemoteUrlUserinfo(rawRemote) : undefined;
  const bindable = newRoots.map(({ path, mapping }): BindableRoot => ({
    path,
    projectRoot: mapping.projectRoot,
    projectKey: mapping.projectKey,
    projectName: generateProjectProposal(mapping.projectRoot, remote, deps.auth.orgKey).projectName,
  }));
  const results = (await bindNewRoots(bindable, remote, deps)) ?? [];
  return new Map(results.map((result) => [result.path, result]));
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
  /** Roots whose key was generated, by `pathComparisonKey`. */
  generatedRoots?: Set<string>;
  /** Roots the user pointed at another project than the one recorded, at the project prompt. */
  relinked?: Set<string>;
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

/**
 * Exactly 'sonar link --monorepo': a linked root is offered a relink, the others a detected
 * project or a search. One root's prompts finish before the next root's start. A root the user
 * keeps as it is stays out of the result.
 */
function pickProjects(
  roots: readonly { path: string; resolved: string }[],
  { chooseProject, console }: Pick<DetectDeps, 'chooseProject' | 'console'>,
  items: readonly ConfigItem[],
): Promise<Map<string, string>> {
  return roots.reduce(async (previous, { path, resolved }) => {
    const picked = await previous;
    console.info(`Choosing the project for ${path}`);
    const projectKey = await chooseProject?.(resolved, items);
    if (projectKey) {
      picked.set(resolved, projectKey);
    }
    return picked;
  }, Promise.resolve(new Map<string, string>()));
}

/** Turns `--root` values into mappings on the active connection, before any root is touched. */
async function mapExplicitRoots(
  projectRoot: string,
  explicitRoots: readonly MonorepoRootOption[],
  deps: DetectDeps,
  linkOnly: boolean,
): Promise<MappedRoots> {
  const { auth } = deps;
  const { targetDir } = await resolveProjectTarget(projectRoot);
  const needsKey = explicitRoots.some(({ projectKey }) => projectKey === undefined);
  const recorded = needsKey ? await sharedProjectConfigRepository.load(targetDir) : [];
  const { gitRoot, isGit } = findGitRoot(targetDir);
  const rawRemote = isGit ? await getGitRemote(gitRoot) : '';
  const remote = rawRemote ? stripGitRemoteUrlUserinfo(rawRemote) : undefined;

  const roots = explicitRoots.map((root) => {
    const resolved = resolveContainedPath(targetDir, root.path);
    if (resolved === null) {
      throw new InvalidOptionError(
        `--root path "${root.path}" must point to an existing directory inside ${targetDir}.`,
      );
    }
    return { ...root, resolved };
  });
  const picked =
    linkOnly && deps.chooseProject
      ? await pickProjects(
          roots.filter(({ projectKey }) => projectKey === undefined),
          deps,
          await sharedProjectConfigFile.readItems(targetDir, throwOnInvalidConfig),
        )
      : new Map<string, string>();

  const generatedKeys: GeneratedKey[] = [];
  const generatedRoots = new Set<string>();
  const mappings = roots.map(({ path, projectKey, resolved }) => {
    const named = projectKey ?? picked.get(resolved);
    const key =
      named === undefined
        ? keyForUnkeyedRoot(resolved, recorded, remote, auth)
        : { projectKey: named, generated: false };
    // Scripts get no say in a guessed key, so link-only wants it named.
    if (linkOnly && key.generated && !deps.interactive) {
      throw new InvalidOptionError(
        `--link needs an existing project for ${path}, but no key is recorded for it.`,
        `Name it with --root ${path}=<project key>.`,
      );
    }
    if (key.generated) {
      generatedKeys.push({ path, projectKey: key.projectKey });
      generatedRoots.add(pathComparisonKey(resolved));
    }
    return {
      projectRoot: resolved,
      projectKey: key.projectKey,
      serverUrl: auth.serverUrl,
      organization: auth.orgKey,
    };
  });
  // A key picked at the prompt that differs from the recorded one is a relink, not a conflict.
  const relinked = new Set(
    [...picked]
      .filter(
        ([root, key]) => recorded.find(({ projectRoot: r }) => r === root)?.projectKey !== key,
      )
      .map(([root]) => root),
  );
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
  return { mappings, repositoryRoot: targetDir, generatedKeys, remote, relinked, generatedRoots };
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
  linkOnly: boolean,
  bound: ReadonlyMap<string, MonorepoRootResult>,
): Promise<MonorepoRootResult[]> {
  return roots.reduce<Promise<MonorepoRootResult[]>>(async (previous, root) => {
    const results = await previous;
    results.push(await onboardRoot(root, deps, linkOnly, bound));
    return results;
  }, Promise.resolve([]));
}
