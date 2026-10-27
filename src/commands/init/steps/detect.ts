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
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { findGitRoot, getGitRemote } from '@/core/host/git/discover.ts';
import { canonicalizePath, isAncestorOrSelf } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import {
  type SharedProjectConfigMapping,
  sharedProjectConfigRepository,
} from '@/core/project-discovery/shared-project-config.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { type GitRemoteBinding, ProjectBindingsClient } from '@/core/server/project-bindings.ts';
import type { Console } from '@/core/ui/console.ts';

import type { InitOutcome } from '../init-outcome.ts';
import { isBindableRemote } from '../remote-host.ts';

export interface DetectDeps {
  auth: ResolvedAuth;
  console: Console;
  interactive: boolean;
}

export function resolveScanRoot(pathOption: string): string {
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

/** Mappings on the scan root's ancestry line, either direction, so a monorepo root counts too. */
function mappingsOnPath(
  mappings: SharedProjectConfigMapping[],
  projectRoot: string,
): SharedProjectConfigMapping[] {
  return mappings.filter(
    (mapping) =>
      isAncestorOrSelf(mapping.projectRoot, projectRoot) ||
      isAncestorOrSelf(projectRoot, mapping.projectRoot),
  );
}

/** Organization that a mapping on the same server records, when it differs from the active one. */
function recordedOtherOrganization(
  mappings: SharedProjectConfigMapping[],
  auth: ResolvedAuth,
): string | undefined {
  return mappings.find(
    (mapping) =>
      authMatchesRecordedServer(auth, mapping.serverUrl) &&
      mapping.organization !== undefined &&
      mapping.organization !== auth.orgKey,
  )?.organization;
}

/** Inspects the directory and its git remote, then picks the onboarding path without running it. */
export async function detectInitPath(projectRoot: string, deps: DetectDeps): Promise<InitOutcome> {
  const { auth } = deps;
  const { gitRoot, isGit } = findGitRoot(projectRoot);

  const mappings = await sharedProjectConfigRepository.load(isGit ? gitRoot : projectRoot);
  const onPath = mappingsOnPath(mappings, projectRoot);
  const linked = onPath.filter((mapping) => authMatchesRecordedConnection(auth, mapping));
  if (linked.length > 0) {
    return { path: 'complete', projectRoot, projectKeys: linked.map((p) => p.projectKey) };
  }

  const remote = isGit ? await getGitRemote(gitRoot) : '';
  if (!remote) {
    return { path: 'unbound-new', projectRoot };
  }

  // Only the server binding proves the project exists; a key in local config may name none.
  const binding = await lookupRemoteBinding(auth, remote);
  switch (binding.kind) {
    case 'in-org':
      return { path: 'link-existing', projectRoot, projectKey: binding.projectKey };
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

function lookupRemoteBinding(auth: ResolvedAuth, remote: string): Promise<GitRemoteBinding> {
  const client = new ProjectBindingsClient(new SonarHttpClient(auth.serverUrl, auth.token));
  return client.resolveGitRemoteBinding(remote, auth.orgKey).match(
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

async function chooseNewProjectPath(
  projectRoot: string,
  remote: string,
  { console, interactive }: DetectDeps,
): Promise<InitOutcome> {
  if (!isBindableRemote(remote)) {
    return { path: 'unbound-new', projectRoot, remote };
  }
  if (!interactive) {
    console.info(
      'Not binding the repository: this needs an answer, and none can be asked.',
      'stderr',
    );
    return { path: 'unbound-new', projectRoot, remote };
  }

  const bind = await console.confirmPrompt(
    'Bind this repository to a new SonarQube project?',
    true,
  );
  if (bind === null) {
    throw new CommandFailedError('Onboarding cancelled.');
  }
  return bind
    ? { path: 'bound-new', projectRoot, remote }
    : { path: 'unbound-new', projectRoot, remote };
}
