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
import { resolveFormatOption } from '@/core/commands/params.ts';
import { ProjectOrganizationError } from '@/core/errors.ts';
import { resolveProjectKey } from '@/core/project-discovery/project-info.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import type { Console } from '@/core/ui/console.ts';

import { BadgesClient } from './badges-client.ts';
import { BADGE_FORMATS, renderBadges, selectMetrics } from './render.ts';

export interface BadgeOptions {
  project?: string;
  metric?: string[];
  branch?: string;
  format?: string;
  allowPrivate?: boolean;
  nonInteractive?: boolean;
}

async function confirmPrivate(
  project: string,
  options: BadgeOptions,
  console: Console,
): Promise<boolean> {
  console.info(
    `${project} is a private project. Its badge URLs contain a token that lets anyone who has them see project metrics, including the security rating, beyond the selected badges. Only use them in trusted environments, such as a private repository.`,
    'stderr',
  );
  if (options.allowPrivate) return true;
  if (options.nonInteractive || !console.canPrompt()) {
    throw new CommandFailedError('Badge not generated: confirmation required.', {
      remediationHint: 'To confirm, re-run with: sonar badge --allow-private',
    });
  }
  const consent = await console.confirmPrompt(
    'Generate badges for this private project?',
    false,
    'stderr',
  );
  if (consent === null) throw new CommandFailedError('Badge generation cancelled.');
  if (!consent) console.info('Cancelled. No badges were generated.', 'stderr');
  return consent;
}

export async function badge(
  options: BadgeOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { console, auth } = ctx;
  const http = ctx.connection.httpClient;
  const format = resolveFormatOption(options.format, BADGE_FORMATS, 'markdown');
  const metrics = selectMetrics(options.metric, http.isCloud);
  const project = await resolveProjectKey(options.project, auth, console, true);
  const client = new BadgesClient(http);
  const component = await client.components.getComponent(project).orThrow();
  if (component?.qualifier !== 'TRK') {
    throw new CommandFailedError(`Project '${project}' does not exist or is not accessible.`);
  }
  if (component.visibility !== 'public' && component.visibility !== 'private') {
    throw new CommandFailedError(`Could not determine visibility for project '${project}'.`);
  }
  if (http.isCloud && (!auth.orgKey || component.organization !== auth.orgKey)) {
    throw new ProjectOrganizationError(project, auth.orgKey ?? '', component.organization);
  }
  if (component.visibility === 'private' && !(await confirmPrivate(project, options, console)))
    return;

  let token: string | undefined;
  if (!http.isCloud || component.visibility === 'private') {
    const value = await client.getToken(project).orThrow();
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new CommandFailedError(`Could not retrieve a badge token for project '${project}'.`);
    }
    token = value;
  }
  const payload = renderBadges({
    project,
    branch: options.branch,
    baseUrl: http.baseUrl,
    isCloud: http.isCloud,
    token,
    metrics,
    format,
  });
  noteProject(auth, project);
  console.print(payload);
}
