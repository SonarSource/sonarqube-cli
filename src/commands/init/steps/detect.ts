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
  /** The path the caller consented to with `--link`, `--bind` or `--create`. */
  intent?: InitIntent;
  /**
   * `--monorepo --link`: picks the existing project for a root named without a key, as
   * `sonar link --monorepo` does. Resolves to `null` when the root keeps its link.
   */
  chooseProject?: (projectRoot: string, items: readonly ConfigItem[]) => Promise<string | null>;
  /** Set only while the user may still be asked which single folder to link. */
  pickLinkFolder?: boolean;
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

/** Organization that a mapping on the same server records, when it differs from the active one. */
function recordedOtherOrganization(
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

/** Inspects the directory and its git remote, then picks the onboarding path without running it. */
export async function detectInitPath(projectRoot: string, deps: DetectDeps): Promise<InitPath> {
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
  // A project below the root leaves the rest of it unlinked, so only enclosing mappings count.
  const linked = onPath.filter(
    (mapping) => mapping.contains && authMatchesRecordedConnection(auth, mapping),
  );
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
    if (intent?.kind === 'bind') {
      throw bindingUnavailable('this directory has no git remote.');
    }
    return { path: 'unbound-new', projectRoot };
  }

  // Only the server binding proves the project exists; a key in local config may name none.
  const binding = await lookupRemoteBinding(deps, remote);
  switch (binding.kind) {
    case 'in-org':
      return {
        path: 'link-existing',
        projectRoot,
        remote,
        projectKey: binding.projectKey,
      };
    case 'other-org':
      throw otherOrganizationError(auth, recordedOtherOrganization(onPath, auth));
    case 'unknown':
      deps.console.info(
        'Could not check whether this repository is already bound; continuing without that check.',
        'stderr',
      );
      break;
    case 'unbound':
      break;
  }
  return chooseNewProjectPath(projectRoot, remote, deps);
}

function lookupRemoteBinding(
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

function otherOrganizationError(
  auth: ResolvedAuth,
  boundOrganization: string | undefined,
): CommandFailedError {
  const active = auth.orgKey ?? 'the active one';
  if (boundOrganization) {
    return new CommandFailedError(
      `This repository is bound to a project in organization '${boundOrganization}', but you are connected to '${active}'.`,
      { remediationHint: `Run 'sonar auth org ${boundOrganization}' to switch to it.` },
    );
  }
  return new CommandFailedError(
    `This repository is bound to a project in another organization than ${active}, so it cannot be bound from here.`,
    { remediationHint: "Run 'sonar auth org' to switch to the organization that owns it." },
  );
}

function bindingUnavailable(reason: string): InvalidOptionError {
  return new InvalidOptionError(
    `--bind is unavailable: ${reason}`,
    "Run 'sonar init' again with --create, or with --link <key> to link an existing project.",
  );
}

async function chooseNewProjectPath(
  projectRoot: string,
  remote: string,
  { auth, console, interactive, intent }: DetectDeps,
): Promise<InitPath> {
  // The import needs the repository slug, so a remote without one is never offered for binding.
  const repositorySlug = remoteRepositorySlug(remote);
  if (repositorySlug === null) {
    if (intent?.kind === 'bind') {
      throw bindingUnavailable('the git remote is not a GitHub or Azure DevOps repository.');
    }
    return { path: 'unbound-new', projectRoot, remote };
  }
  if (auth.connectionType !== 'cloud') {
    if (intent?.kind === 'bind') {
      throw bindingUnavailable('creating a bound project is only available on SonarQube Cloud.');
    }
    if (!intent) {
      console.info(
        'Creating a bound project is only available on SonarQube Cloud for now.',
        'stderr',
      );
    }
    return { path: 'unbound-new', projectRoot, remote };
  }
  if (intent?.kind === 'bind') {
    return { path: 'bound-new', projectRoot, remote, repositorySlug };
  }
  if (intent || !interactive) {
    // Without an intent, the unbound step asks for one once it knows no project exists.
    return { path: 'unbound-new', projectRoot, remote, repositorySlug };
  }

  const bind = requireAnswer(
    await console.confirmPrompt('Bind this repository to a new SonarQube project?', true),
  );
  return bind
    ? { path: 'bound-new', projectRoot, remote, repositorySlug }
    : { path: 'unbound-new', projectRoot, remote };
}
