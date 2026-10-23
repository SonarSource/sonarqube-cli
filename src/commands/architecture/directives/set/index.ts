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

import { readFile } from 'node:fs/promises';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';

import { createDirectivesApi } from '../../_common/architecture-api.ts';
import { applyDirectiveChanges, parseDirectiveChanges } from '../../_common/directives.ts';
import { toArchitectureError } from '../../_common/errors.ts';
import { resolveProject } from '../../_common/project.ts';
import { recordSet, type SetFileOptions } from '../../_common/write-options.ts';

export async function setProjectDirectives(
  options: SetFileOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const projectKey = await resolveProject(options, ctx);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(options.file, 'utf8'));
  } catch (error) {
    throw new CommandFailedError('Could not read the directives JSON file. Nothing was changed.', {
      cause: error,
    });
  }
  const changes = parseDirectiveChanges(value, projectKey);
  const result = await applyDirectiveChanges(
    createDirectivesApi(ctx.connection, projectKey),
    changes,
    options.dryRun === true,
  ).catch((error: unknown) => {
    throw toArchitectureError(error, projectKey);
  });
  recordSet(ctx, {
    target: 'directives',
    mode: result.mode,
    dry_run: options.dryRun === true,
    removed: result.toDelete.length,
    added: result.toCreate.length,
    changed: result.changes.length,
    created: result.created.length,
    skipped: result.skipped,
  });
  const prefix = options.dryRun ? 'Would' : 'Did';
  for (const item of result.toCreate) {
    ctx.console.info(
      `${prefix} create: ${item.type} ${item.ecosystem} ${item.graphType}${item.graphPerspective ? ` [${item.graphPerspective}]` : ''} ${item.fromNodeKey} -> ${item.toNodeKey}`,
    );
    if (item.description !== undefined)
      ctx.console.info(`  description: ${JSON.stringify(item.description)}`);
  }
  for (const change of result.changes) {
    ctx.console.info(`${prefix} update: ${change.id}`);
    for (const key of Object.keys(change.after) as (keyof typeof change.after)[])
      if (change.before[key] !== change.after[key])
        ctx.console.info(
          `  ${key}: ${change.before[key] === undefined ? '(unset)' : JSON.stringify(change.before[key])} -> ${JSON.stringify(change.after[key])}`,
        );
  }
  for (const item of result.toDelete)
    ctx.console.info(
      `${prefix} delete: ${item.id} ${item.type} ${item.fromNodeKey} -> ${item.toNodeKey}`,
    );
  ctx.console.info(`Skipped ${result.skipped} existing, repeated or unchanged directives.`);
  ctx.console.info(
    options.dryRun
      ? 'Dry run: nothing was written.'
      : `Created ${result.created.length} directives. Updated ${result.updated.length} directives. Deleted ${result.deleted.length} directives. Unmentioned directives were retained.`,
  );
  ctx.console.warn(
    'Concurrent edits can race the reads; the public API has no conditional writes. Changes are applied individually without automatic retry or rollback.',
  );
}
