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

// Project resolution for the per-edit SQAA hooks, shared by every agent's PostToolUse handler.

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { authMatchesRecordedConnection } from '@/core/auth/recorded-connection.ts';
import logger from '@/core/observability/logger.ts';
import type { CompleteProjectMapping } from '@/core/project-discovery/project-discovery-result.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import type { Console } from '@/core/ui/console.ts';

import { discoverSqaaProjects } from '../analyze/sqaa-resolution.ts';

/**
 * The project owning an edited file, resolved like `sonar analyze` does: the hook's cwd decides
 * which mappings are in play, and the deepest root containing the file wins. Unlike
 * `discoverProject()`, a monorepo with several projects below the cwd is not ambiguous, since
 * each edit belongs to exactly one of them. Undefined when no project owns the file, or when
 * the owner is recorded against another server or organization: the source goes to the active
 * connection only, and the nearest owner wins, so the file is not handed to a project above it.
 */
export async function resolveHookProject(
  auth: ResolvedAuth,
  console: Console,
  canonicalPath: string,
): Promise<CompleteProjectMapping | undefined> {
  const discovered = await discoverSqaaProjects(auth, console);
  const mapping = discovered
    .focusedOn(process.cwd())
    .groupByMapping([canonicalPath])
    .groups.at(0)?.mapping;
  if (!mapping) {
    return undefined;
  }
  if (!authMatchesRecordedConnection(auth, mapping)) {
    logger.debug(
      `Hook SQAA skipped: project ${mapping.projectKey} is recorded against another connection`,
    );
    return undefined;
  }
  noteProject(auth, mapping.projectKey);
  return mapping;
}
