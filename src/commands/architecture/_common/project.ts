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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import {
  assertSingleLineProjectKey,
  discoverProject,
} from '@/core/project-discovery/project-info.ts';

export async function resolveProject(
  options: { project?: string },
  ctx: CommandAuthenticatedInvocationContext,
): Promise<string> {
  const projectKey =
    options.project ??
    (
      await discoverProject(process.cwd(), {
        auth: ctx.auth,
        silent: true,
        console: ctx.console,
      })
    ).projectKey;
  if (!projectKey) {
    throw new CommandFailedError('Could not determine project key.', {
      remediationHint:
        "Use --project <key>, run from inside a linked project directory, or run 'sonar link <projectKey>' to link this repository.",
    });
  }
  assertSingleLineProjectKey(projectKey);
  ctx.console.print(
    `     Using ${options.project ? '' : 'auto-detected '}project key: ${projectKey}`,
    'stderr',
  );
  return projectKey;
}
