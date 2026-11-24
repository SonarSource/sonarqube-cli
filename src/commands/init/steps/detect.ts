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

import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import {
  authMatchesRecordedConnection,
  authMatchesRecordedServer,
} from '@/core/auth/recorded-connection.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import { findGitRoot, getGitRemote } from '@/core/host/git/discover.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import type { CompleteProjectMapping } from '@/core/project-discovery/project-discovery-result.ts';
import { discoverProjects } from '@/core/project-discovery/project-info.ts';
import type { ConfigItem } from '@/core/project-discovery/shared-project-config.ts';
import { stripGitRemoteUrlUserinfo } from '@/core/server/git-remote-url.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';
import { type GitRemoteBinding, ProjectBindingsClient } from '@/core/server/project-bindings.ts';
import type { Console } from '@/core/ui/console.ts';

import { requireAnswer } from '../answer.ts';
import type { InitPathId } from '../flow/step-ids.ts';
import { alreadyDone, declined, skipped, type StepResult, success } from '../flow/step-result.ts';
import type { Detected, InitRoot, InitStep, StepRef, StepRunner } from '../flow/step-runner.ts';
import type { InitPath } from '../init-outcome.ts';
import type { InitIntent } from '../options.ts';
import { remoteRepositorySlug } from '../remote-host.ts';

export interface DetectDeps {
  auth: ResolvedAuth;
  /** Bound to `auth`'s server and token. */
  http: SonarHttpClient;
  console: Console;
  interactive: boolean;
  /** `--dry-run`: every step stops before its first write and reports what it would do. */
  dryRun?: boolean;
  /** The path the caller consented to with `--link` or `--bind`. */
  intent?: InitIntent;
  /**
   * `--monorepo --link`: picks the existing project for a root named without a key, as
   * `sonar link --monorepo` does. Resolves to `null` when the root keeps its link.
   */
  chooseProject?: (projectRoot: string, items: readonly ConfigItem[]) => Promise<string | null>;
  /** Set only while the user may still be asked which single folder to link. */
  pickLinkFolder?: boolean;
  /** Runs the onboarding steps and records in telemetry how each went. */
  steps: StepRunner;
  /** The project root the steps run for. */
  root: InitRoot;
}

export function resolveProjectRoot(pathOption: string): string {
  const root = resolve(process.cwd(), pathOption);
  let isDirectory = false;
  try {
    isDirectory = statSync(root).isDirectory();
  } catch {
    // reported below, same as a path that is not a directory
  }
  if (!isDirectory) {
    throw new CommandFailedError(`--path "${pathOption}" is not an existing directory.`, {
      remediationHint: 'Pass a directory inside your repository, for example --path .',
    });
  }
  return canonicalizePath(root);
}

// A committed config is untrusted and the name ends up in a command the user is told to run.
const ORGANIZATION_KEY = /^[A-Za-z0-9_.-]+$/;

/** Inspects the directory and its git remote, then picks the onboarding path without running it. */
export class DetectStep implements InitStep<Detected<InitPath>[]> {
  readonly ref = { step: 'detect' } as const;

  constructor(
    private readonly projectRoot: string,
    private readonly deps: DetectDeps,
  ) {}

  async run(): Promise<StepResult<Detected<InitPath>[]>> {
    const path = await this.findPath();
    const roots = [{ root: this.deps.root, initPath: this.initPathIdOf(path), target: path }];
    return path.path === 'complete' ? alreadyDone(roots, { roots }) : success(roots, { roots });
  }

  private async findPath(): Promise<InitPath> {
    const { projectRoot, deps } = this;

    const { auth } = deps;
    const { gitRoot, isGit } = findGitRoot(projectRoot);

    // Local config and known mappings prove no server project exists, so only `.sonar-config.json` counts.
    const discovered = await discoverProjects(projectRoot, {
      auth,
      console: deps.console,
      silent: true,
      useKnownMappings: false,
      useGitRemoteBinding: false,
    });
    const onPath = discovered.fromSharedConfig ? discovered.scope(projectRoot) : [];
    const connected = onPath.filter((mapping) => authMatchesRecordedConnection(auth, mapping));
    const enclosing = connected.filter((mapping) => mapping.contains);
    // A lone project below the root leaves the rest of it unlinked, but several of them are a monorepo.
    const linked = enclosing.length > 0 || connected.length < 2 ? enclosing : connected;
    if (linked.length > 0) {
      return {
        path: 'complete',
        projectRoot,
        projects: linked.map(({ projectKey, projectRoot: root }) => ({
          projectKey,
          projectRoot: root,
        })),
      };
    }

    const rawRemote = isGit ? await getGitRemote(gitRoot) : '';
    const remote = rawRemote ? stripGitRemoteUrlUserinfo(rawRemote) : undefined;
    const { intent } = deps;
    if (intent?.kind === 'link' && intent.projectKey) {
      return {
        path: 'link-existing',
        projectRoot,
        remote,
        projectKey: intent.projectKey,
        requested: true,
      };
    }
    if (!remote) {
      return this.chooseNewProjectPath(undefined);
    }

    // Only the server binding proves the project exists; a key in local config may name none.
    const binding = await this.lookupRemoteBinding(deps, remote);
    switch (binding.kind) {
      case 'in-org':
        return {
          path: 'link-existing',
          projectRoot,
          remote,
          projectKey: binding.projectKey,
        };
      case 'other-org':
        throw this.otherOrganizationError(auth, this.recordedOtherOrganization(onPath, auth));
      case 'unknown':
        deps.console.info(
          'Could not check whether this repository is already bound; continuing without that check.',
          'stderr',
        );
        break;
      case 'unbound':
        break;
    }
    return this.chooseNewProjectPath(remote);
  }

  /** Picks the path of a new project. Only the binding decision is a step; the check before it is not. */
  private chooseNewProjectPath(remote: string | undefined): Promise<InitPath> {
    this.assertBindingPossible(remote, this.deps);
    return this.deps.steps.run(new ProjectBindStep(this.projectRoot, remote, this.deps));
  }

  /** Organization that a mapping on the same server records, when it differs from the active one. */
  private recordedOtherOrganization(
    mappings: CompleteProjectMapping[],
    auth: ResolvedAuth,
  ): string | undefined {
    return mappings.find(
      (mapping) =>
        authMatchesRecordedServer(auth, mapping.serverUrl) &&
        mapping.organization !== undefined &&
        ORGANIZATION_KEY.test(mapping.organization) &&
        mapping.organization !== auth.orgKey,
    )?.organization;
  }

  /** The path a directory is expected to take, before it runs; its steps may change it. */
  private initPathIdOf(detected: InitPath): InitPathId {
    switch (detected.path) {
      case 'complete':
        return 'already_done';
      case 'link-existing':
        return 'link_existing';
      case 'bound-new':
        return 'bound_new';
      // The telemetry id predates the removal of unbound creation, and names the same path.
      case 'no-project':
        return 'unbound_new';
    }
  }

  private lookupRemoteBinding(
    { auth, http }: DetectDeps,
    remote: string,
  ): Promise<GitRemoteBinding> {
    return new ProjectBindingsClient(http).resolveGitRemoteBinding(remote, auth.orgKey).match(
      (binding) => binding,
      (error): GitRemoteBinding => {
        logger.debug(`Git remote project binding lookup failed: ${error.message}`);
        return { kind: 'unknown' };
      },
    );
  }

  private otherOrganizationError(
    auth: ResolvedAuth,
    boundOrganization: string | undefined,
  ): RepositoryInOtherOrganizationError {
    const active = auth.orgKey ?? 'the active one';
    if (boundOrganization) {
      return new RepositoryInOtherOrganizationError(
        `This repository is bound to a project in organization '${boundOrganization}', but you are connected to '${active}'.`,
        `Run 'sonar auth org ${boundOrganization}' to switch to it.`,
      );
    }
    return new RepositoryInOtherOrganizationError(
      `This repository is bound to a project in another organization than ${active}, so it cannot be bound from here.`,
      "Run 'sonar auth org' to switch to the organization that owns it.",
    );
  }

  private bindingUnavailable(reason: string): InvalidOptionError {
    return new InvalidOptionError(
      `--bind is unavailable: ${reason}`,
      "Run 'sonar init' again with --link <key> to link an existing project.",
    );
  }

  /** `--bind` that cannot be honoured fails before the step, so such a run reports no project. */
  private assertBindingPossible(remote: string | undefined, { auth, intent }: DetectDeps): void {
    if (intent?.kind !== 'bind') {
      return;
    }
    if (!remote) {
      throw this.bindingUnavailable('this directory has no git remote.');
    }
    if (remoteRepositorySlug(remote) === null) {
      throw this.bindingUnavailable('the git remote is not a GitHub or Azure DevOps repository.');
    }
    if (auth.connectionType !== 'cloud') {
      throw this.bindingUnavailable(
        'creating a bound project is only available on SonarQube Cloud.',
      );
    }
  }
}

/** Whether a new project is bound to the repository: `--bind`, the user's answer, or what the remote allows. */
class ProjectBindStep implements InitStep<InitPath> {
  readonly ref: StepRef;
  readonly initPath = 'bound_new';

  constructor(
    private readonly projectRoot: string,
    private readonly remote: string | undefined,
    private readonly deps: DetectDeps,
  ) {
    this.ref = { step: 'project_bind', root: deps.root };
  }

  async run(): Promise<StepResult<InitPath>> {
    const { projectRoot, remote } = this;
    const { auth, console, interactive, intent } = this.deps;

    if (!remote) {
      return skipped({ path: 'no-project', projectRoot });
    }
    // The import needs the repository slug, so a remote without one is never offered for binding.
    const repositorySlug = remoteRepositorySlug(remote);
    if (repositorySlug === null) {
      return skipped({ path: 'no-project', projectRoot, remote });
    }
    if (auth.connectionType !== 'cloud') {
      if (!intent) {
        console.info(
          'Creating a bound project is only available on SonarQube Cloud for now.',
          'stderr',
        );
      }
      return skipped({ path: 'no-project', projectRoot, remote });
    }
    if (intent?.kind === 'bind') {
      return success({ path: 'bound-new', projectRoot, remote, repositorySlug });
    }
    if (intent || !interactive) {
      // Without an intent, the no-project step names the options that would answer it.
      return skipped({ path: 'no-project', projectRoot, remote, repositorySlug });
    }

    const bind = requireAnswer(
      await console.confirmPrompt('Bind this repository to a new SonarQube project?', true),
    );
    return bind
      ? success({ path: 'bound-new', projectRoot, remote, repositorySlug })
      : declined({ path: 'no-project', projectRoot, remote });
  }
}

/** The repository's project belongs to another organization than the active one. */
export class RepositoryInOtherOrganizationError extends CommandFailedError {
  constructor(message: string, remediationHint: string) {
    super(message, { remediationHint });
    this.name = 'RepositoryInOtherOrganizationError';
  }
}
