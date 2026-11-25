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

import { failed, type StepResult, success } from '../../flow/step-result.ts';
import type { Detected, InitStep } from '../../flow/step-runner.ts';
import { generateProjectProposal } from '../../key-proposal.ts';
import type { MonorepoRootOption } from '../../options.ts';
import type { DetectDeps } from '../detect.ts';
import {
  describeFailure,
  findLinkedProjectIssues,
  isRunFatal,
  type LinkedProjectIssue,
  reportLinkedProjectIssues,
} from '../linked-projects.ts';
import { linkCommand } from '../mapping.ts';
import { planRoot } from './plan-root.ts';
import type { MonorepoRoot, RootOnboarding, RootStatus } from './root-onboarding.ts';

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

export /** Finds the roots to onboard, where each stands and how it is onboarded; a run that finds none fails here. */
class DetectRootsStep implements InitStep<Detected<RootOnboarding>[] | undefined> {
  readonly ref = { step: 'detect' } as const;

  constructor(
    private readonly projectRoot: string,
    private readonly deps: DetectDeps,
    private readonly explicitRoots: readonly MonorepoRootOption[],
    private readonly linkOnly: boolean,
  ) {}

  async run(): Promise<StepResult<Detected<RootOnboarding>[] | undefined>> {
    const { projectRoot, deps, explicitRoots, linkOnly } = this;

    const { console } = deps;
    const named =
      explicitRoots.length > 0
        ? await this.mapExplicitRoots(projectRoot, explicitRoots, deps, linkOnly)
        : undefined;
    // Read after the named roots are mapped, so the file's roots include them.
    const mapped = await this.discoverMappedRoots(projectRoot, deps);
    const { repositoryRoot, generatedKeys, relinked, remote, generatedRoots } = named ?? mapped;
    const configDir = named?.configDir ?? mapped.configDir;
    const namedRoots = new Set(
      (named?.mappings ?? []).map(({ projectRoot: root }) => pathComparisonKey(root)),
    );
    const mappings = [
      ...(named?.mappings ?? []),
      ...mapped.mappings.filter(
        ({ projectRoot: root }) => !namedRoots.has(pathComparisonKey(root)),
      ),
    ];
    if (mappings.length === 0) {
      return failed(undefined, undefined, 'unknown');
    }

    this.warnOnNestedConfig(configDir, repositoryRoot, console);
    generatedKeys?.forEach(({ path, projectKey }) => {
      console.print(`Generated project key for ${path}: ${projectKey}`);
    });
    const roots = await console.withSpinner('Checking the mapped project roots', () =>
      Promise.all(
        mappings.map(async (mapping, index): Promise<MonorepoRoot> => {
          const isNamed = namedRoots.has(pathComparisonKey(mapping.projectRoot));
          const inspected = await this.inspectRoot(
            mapping,
            repositoryRoot,
            deps,
            isNamed,
            relinked ?? new Set(),
          );
          return {
            ...inspected,
            root: { index, path: inspected.path },
            repositoryRoot,
            remote: isNamed ? remote : undefined,
            generated: generatedRoots?.has(pathComparisonKey(mapping.projectRoot)) ?? false,
          };
        }),
      ),
    );
    this.reportRootProblems(roots, deps);
    const found = roots.map((target) => {
      const onboarding = planRoot(target, { ...deps, root: target.root }, linkOnly);
      return { root: target.root, initPath: onboarding.initPath, target: onboarding };
    });
    return success(found, { roots: found });
  }

  private async classifyRoot(
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
  private async classifyLinkedRoot(
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
  private async classifyExplicitRoot(
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
      return this.classifyRoot(mapping, deps);
    }
    return recorded.projectKey === mapping.projectKey
      ? this.classifyLinkedRoot(mapping, path, deps)
      : { kind: 'conflict', recordedKey: recorded.projectKey };
  }

  /** Roots read from the file are checked on the remote; roots named with `--root` may also be created or mapped. */
  private async inspectRoot(
    mapping: CompleteProjectMapping,
    repositoryRoot: string,
    deps: DetectDeps,
    explicit: boolean,
    relinked: ReadonlySet<string>,
  ): Promise<Pick<MonorepoRoot, 'mapping' | 'path' | 'status'>> {
    const path = relativeProjectPath(repositoryRoot, mapping.projectRoot);
    if (!explicit) {
      return { mapping, path, status: await this.classifyLinkedRoot(mapping, path, deps) };
    }
    try {
      return {
        mapping,
        path,
        status: await this.classifyExplicitRoot(
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
      return {
        mapping,
        path,
        status: {
          kind: 'unchecked',
          reason: describeFailure(error),
          cause: error,
        },
      };
    }
  }

  /** Said before any root is onboarded, while the user can still stop: these roots are left as they are. */
  private reportRootProblems(roots: readonly MonorepoRoot[], { auth, console }: DetectDeps): void {
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

  private async discoverMappedRoots(projectRoot: string, deps: DetectDeps): Promise<MappedRoots> {
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
  private keyForUnkeyedRoot(
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
  private pickProjects(
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
  private async mapExplicitRoots(
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
        ? await this.pickProjects(
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
          ? this.keyForUnkeyedRoot(resolved, recorded, remote, auth)
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
  private warnOnNestedConfig(
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
}
