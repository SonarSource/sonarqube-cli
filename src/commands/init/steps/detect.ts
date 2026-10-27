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
import {
  type SharedProjectConfigMapping,
  sharedProjectConfigRepository,
} from '@/core/project-discovery/shared-project-config.ts';
import { discoverProjectKeyByGitRemote } from '@/core/server/discover-project-by-remote.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { ProjectBindingsClient } from '@/core/server/project-bindings.ts';
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
  const binding = await discoverProjectKeyByGitRemote(auth, remote);
  if (binding) {
    return { path: 'link-existing', projectRoot, projectKey: binding.projectKey };
  }

  // A definitive "no binding" needs no second lookup; anything else may hide another organization.
  if (binding === undefined && (await isBoundToOtherOrg(auth, remote))) {
    return {
      path: 'stop-other-org',
      organization: auth.orgKey,
      boundOrganization: recordedOtherOrganization(onPath, auth),
      remote,
    };
  }
  return chooseNewProjectPath(projectRoot, remote, deps);
}

function isBoundToOtherOrg(auth: ResolvedAuth, remote: string): Promise<boolean> {
  if (auth.connectionType !== 'cloud' || !auth.orgKey) {
    return Promise.resolve(false);
  }
  const client = new ProjectBindingsClient(new SonarHttpClient(auth.serverUrl, auth.token));
  return client.isGitRemoteBoundOutsideOrg(remote, auth.orgKey).match(
    (outside) => outside === true,
    () => false,
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
