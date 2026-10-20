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

import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { canonicalizePath, isAncestorOrSelf } from '@/core/io/fs-utils.ts';
import type { CompleteProjectMapping } from '@/core/project-discovery/project-discovery-result.ts';
import { discoverProjects } from '@/core/project-discovery/project-info.ts';

export interface LinkResolveOptions {
  path?: string;
}

type LinkResolution =
  | { path: string; status: 'resolved'; project: CompleteProjectMapping }
  | {
      path: string;
      status: 'ambiguous';
      /** Projects whose root contains `path` — bounded by its depth, unlike nested ones. */
      enclosingProjects: CompleteProjectMapping[];
      nestedProjectCount: number;
    }
  | { path: string; status: 'none' };

/** Reports the project `sonar context` would use from `path`, in a size that does not grow with the monorepo. */
export async function resolveLink(
  options: LinkResolveOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const path = resolveExistingPath(options.path ?? process.cwd());
  const startDir = statSync(path).isDirectory() ? path : dirname(path);

  const discovered = await discoverProjects(startDir, {
    auth: ctx.auth,
    silent: true,
    console: ctx.console,
  });
  ctx.console.print(JSON.stringify(toResolution(path, discovered.scope(path))));
}

function toResolution(path: string, scoped: CompleteProjectMapping[]): LinkResolution {
  if (scoped.length === 0) {
    return { path, status: 'none' };
  }
  if (scoped.length === 1) {
    return { path, status: 'resolved', project: scoped[0] };
  }
  const enclosingProjects = scoped.filter((project) => isAncestorOrSelf(project.projectRoot, path));
  return {
    path,
    status: 'ambiguous',
    enclosingProjects,
    nestedProjectCount: scoped.length - enclosingProjects.length,
  };
}

export function resolveExistingPath(rawPath: string): string {
  if (!existsSync(rawPath)) {
    throw new InvalidOptionError(`Path "${rawPath}" does not exist.`);
  }
  return canonicalizePath(rawPath);
}
