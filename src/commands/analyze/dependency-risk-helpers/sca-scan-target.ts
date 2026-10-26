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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import {
  assertSingleLineProjectKey,
  discoverProjects,
} from '@/core/project-discovery/project-info.ts';
import { unresolvedProjectError } from '@/core/project-discovery/unresolved-project.ts';
import type { Console } from '@/core/ui/console.ts';

import type { ScaScanTarget } from './sca-scan-orchestrator.ts';

/**
 * Resolve the project to scan from `cwd` and the root to scan it from. An explicit key scans the
 * root of the linked project with that key, or `cwd` when none is linked.
 */
export async function resolveScaScanTarget(
  explicitProject: string | undefined,
  auth: ResolvedAuth,
  console: Console,
  cwd = process.cwd(),
): Promise<ScaScanTarget> {
  if (explicitProject) {
    assertSingleLineProjectKey(explicitProject);
    console.print(`     Using project key: ${explicitProject}`, 'stderr');
    return resolveExplicitScaScanTarget(explicitProject, auth, console, cwd);
  }

  const discovered = await discoverProjects(cwd, { auth, silent: true, console });
  const scoped = discovered.scope(cwd);
  if (scoped.length === 1) {
    const [{ projectKey, projectRoot }] = scoped;
    assertSingleLineProjectKey(projectKey);
    console.print(`     Using auto-detected project key: ${projectKey}`, 'stderr');
    return { projectKey, baseDir: projectRoot };
  }
  if (discovered.fromSharedConfig) {
    throw unresolvedProjectError(discovered, cwd);
  }
  throw new CommandFailedError('Could not determine project key.', {
    remediationHint:
      "Use --project <key>, or run 'sonar link <projectKey>' to link one to this repository.",
  });
}

/** Scans from the root of the linked project with that key, or from `cwd` when none is linked. */
export async function resolveExplicitScaScanTarget(
  projectKey: string,
  auth: ResolvedAuth,
  console: Console,
  cwd: string,
): Promise<ScaScanTarget> {
  const discovered = await discoverProjects(cwd, {
    auth,
    silent: true,
    console,
    useGitRemoteBinding: false,
  });
  const linked = discovered.projects.find((project) => project.projectKey === projectKey);
  return { projectKey, baseDir: linked?.projectRoot ?? canonicalizePath(cwd) };
}
