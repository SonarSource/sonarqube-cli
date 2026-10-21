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

// `sonar architecture intended set`

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createArchitectureApi,
  type IntendedGroup,
} from '@/commands/architecture/_common/architecture-api.ts';
import { toArchitectureError } from '@/commands/architecture/_common/errors.ts';
import type { IntendedDiff } from '@/commands/architecture/_common/intended-diff.ts';
import { parseIntendedFile } from '@/commands/architecture/_common/intended-validation.ts';
import { setIntended as setIntendedModel } from '@/commands/architecture/_common/set-intended.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import {
  type CommandAuthenticatedInvocationContext,
  TelemetryFact,
} from '@/core/commands/invocation-context.ts';
import { CLI_DIR } from '@/core/config-constants.ts';
import { green, red, yellow } from '@/core/ui/colors.ts';

import { resolveProject } from '../../_common/project.ts';

export const CLI_ARCHITECTURE_SET = 'CliArchitectureSet';

/** Domain payload for CliArchitectureSet (identity is filled at drain time). */
export interface ArchitectureSetPayload {
  target: 'intended';
  mode: string;
  dry_run: boolean;
  removed: number;
  added: number;
  changed: number;
  created: number;
  skipped: number;
}

export interface SetFileOptions {
  project?: string;
  file: string;
  dryRun?: boolean;
}

const BACKUP_DIR = join(CLI_DIR, 'architecture', 'backups');

export async function setIntended(
  options: SetFileOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const file = parseIntendedFile(await readJsonFile(options.file));
  const projectKey = await resolveProject(options, ctx);
  const dryRun = options.dryRun === true;
  const result = await setIntendedModel(createArchitectureApi(ctx.connection, projectKey), file, {
    projectKey,
    dryRun,
    backupDir: BACKUP_DIR,
    onReplacement: (current) => {
      if (!current.some((model) => containsPatternImport(model.groups))) return;
      ctx.console.warn(
        'Pattern-linked groups retain their patternId. The server resolves their contents and ignores submitted expanded children.',
      );
    },
  }).catch((error: unknown) => {
    throw toArchitectureError(error, projectKey);
  });

  printDiff(ctx, result.diff);
  if (result.unchecked) {
    ctx.console.warn(
      'The file has no revision, so changes made in SonarQube since it was written could not be detected.',
    );
  }
  if (file.language !== undefined) {
    ctx.console.info(
      `The file holds only the ${file.language} model; the other languages stay as saved.`,
    );
  }
  recordSet(ctx, {
    target: 'intended',
    mode: result.mode,
    dry_run: dryRun,
    removed: result.diff.removed.length,
    added: result.diff.added.length,
    changed: result.diff.changed.length,
    created: 0,
    skipped: 0,
  });

  if (result.mode === 'dry-run') {
    ctx.console.info('Dry run: nothing was written. Run without --dry-run to apply.');
    return;
  }
  if (result.mode === 'unchanged') {
    ctx.console.info(
      `The intended architecture of '${projectKey}' already matches the file; nothing was written.`,
    );
    return;
  }
  const verbs = { created: 'Created', updated: 'Updated', cleared: 'Cleared' } as const;
  const verb = verbs[result.mode];
  ctx.console.success(`${verb} the intended architecture of '${projectKey}'.`);
  if (result.backupPath !== undefined) {
    ctx.console.info(`The previous one is backed up in ${result.backupPath}`);
  }
  ctx.console.info('SonarQube applies it from the next analysis.');
}

async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new CommandFailedError(`Cannot read ${path}.`, { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CommandFailedError(`${path} is not valid JSON; nothing was changed.`, {
      cause: error,
    });
  }
}

function printDiff(ctx: CommandAuthenticatedInvocationContext, diff: IntendedDiff): void {
  for (const line of diff.removed) ctx.console.print(red(`  - ${line}`));
  for (const line of diff.added) ctx.console.print(green(`  + ${line}`));
  for (const line of diff.changed) ctx.console.print(yellow(`  ~ ${line}`));
  ctx.console.print(
    `${diff.removed.length} removed, ${diff.added.length} added, ${diff.changed.length} changed.`,
  );
}

function recordSet(
  ctx: CommandAuthenticatedInvocationContext,
  payload: ArchitectureSetPayload,
): void {
  ctx.recordTelemetry(
    new TelemetryFact<ArchitectureSetPayload>(CLI_ARCHITECTURE_SET, payload, {
      auth: ctx.auth,
    }),
  );
}

function containsPatternImport(groups: IntendedGroup[]): boolean {
  return groups.some(
    (group) => group.patternId !== undefined || containsPatternImport(group.groups ?? []),
  );
}
