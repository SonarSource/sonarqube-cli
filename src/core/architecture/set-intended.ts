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

// Back up and replace complete public models; reconcile uncertain responses without rollback.

import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CommandFailedError } from '@/core/commands/command-error.ts';

import type { ArchitectureApi, IntendedArchitecture } from './architecture-api.ts';
import { toArchitectureError } from './errors.ts';
import { diffIntended, type IntendedDiff, isEmptyDiff } from './intended-diff.ts';
import { revisionOf } from './intended-model.ts';
import type { IntendedFile } from './intended-validation.ts';
import { shellQuote } from './shell-quote.ts';

const BACKUP_DIRECTORY_MODE = 0o700;

export type SetIntendedMode = 'dry-run' | 'unchanged' | 'created' | 'updated' | 'cleared';

export interface SetIntendedResult {
  mode: SetIntendedMode;
  diff: IntendedDiff;
  /** Set when the saved model was backed up before being changed. */
  backupPath?: string;
  /** True when the file had no revision, so no stale check could be made. */
  unchecked: boolean;
}

export interface SetIntendedOptions {
  projectKey: string;
  dryRun: boolean;
  backupDir: string;
}

export async function setIntended(
  api: ArchitectureApi,
  file: IntendedFile,
  options: SetIntendedOptions,
): Promise<SetIntendedResult> {
  const current = await api.getIntended();
  const next = file.language === undefined ? file.models : withLanguage(current, file);
  const diff = diffIntended(current, next);
  const unchecked = file.revision === undefined;
  if (file.revision !== undefined && file.revision !== revisionOf(current)) {
    throw staleError(options.projectKey);
  }
  if (options.dryRun) return { mode: 'dry-run', diff, unchecked };
  if (isEmptyDiff(diff)) return { mode: 'unchanged', diff, unchecked };
  if (current.length === 0) {
    await writeModel(api, next, 'create', options.projectKey);
    return { mode: 'created', diff, unchecked };
  }
  const backupPath = await writeBackup(options.backupDir, options.projectKey, current);
  if (revisionOf(await api.getIntended()) !== revisionOf(current))
    throw staleError(options.projectKey);
  const operation = next.length === 0 ? 'clear' : 'update';
  await writeModel(api, next, operation, options.projectKey, backupPath);
  return { mode: operation === 'clear' ? 'cleared' : 'updated', diff, backupPath, unchecked };
}

async function writeModel(
  api: ArchitectureApi,
  next: IntendedArchitecture[],
  operation: 'create' | 'update' | 'clear',
  projectKey: string,
  backupPath?: string,
): Promise<void> {
  try {
    if (operation === 'create') await api.createIntended(next);
    else if (operation === 'update') await api.updateIntended(next);
    else await api.deleteIntended();
    if (revisionOf(await api.getIntended()) !== revisionOf(next)) {
      throw new CommandFailedError(
        'The public read after writing does not match the requested model.',
      );
    }
  } catch (error) {
    await reconcileWrite(api, next, projectKey, error, backupPath);
  }
}

async function reconcileWrite(
  api: ArchitectureApi,
  next: IntendedArchitecture[],
  projectKey: string,
  error: unknown,
  backupPath?: string,
): Promise<void> {
  const writeError = toArchitectureError(error, projectKey);
  let saved: IntendedArchitecture[];
  try {
    saved = await api.getIntended();
  } catch (readError) {
    throw writeFailure(projectKey, writeError, backupPath, readError);
  }
  if (revisionOf(saved) === revisionOf(next)) return;
  throw writeFailure(projectKey, writeError, backupPath);
}

function writeFailure(
  projectKey: string,
  error: unknown,
  backupPath?: string,
  readError?: unknown,
): CommandFailedError {
  const lines = [
    'The architecture write failed; inspect the current server state before restoring. No automatic rollback was attempted.',
    `Write failed: ${messageOf(error)}`,
  ];
  if (readError !== undefined)
    lines.push(`The server state is unknown. Read failed: ${messageOf(readError)}`);
  if (backupPath !== undefined) {
    lines.push(
      `The previous export is saved in ${backupPath}`,
      `Restore it with: sonar architecture set intended --project ${shellQuote(projectKey)} --file ${shellQuote(backupPath)}`,
    );
  }
  return new CommandFailedError(lines.join('\n'), { cause: error });
}

/** The saved models with the file's language replaced by the file's model (or removed). */
function withLanguage(current: IntendedArchitecture[], file: IntendedFile): IntendedArchitecture[] {
  const others = current.filter(({ language }) => language !== file.language);
  return [...others, ...file.models];
}

async function writeBackup(
  backupDir: string,
  projectKey: string,
  models: IntendedArchitecture[],
): Promise<string> {
  await mkdir(backupDir, { recursive: true, mode: BACKUP_DIRECTORY_MODE });
  if (!(await lstat(backupDir)).isDirectory()) {
    throw new CommandFailedError('The architecture backup path must be a real directory.');
  }
  await chmod(backupDir, BACKUP_DIRECTORY_MODE);
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const path = join(
    backupDir,
    `${projectKey.replaceAll(/[^\w.-]/g, '_')}-${stamp}-${randomUUID()}.json`,
  );
  // No revision: the backup is applied over a project whose model has already changed.
  await writeFile(path, `${JSON.stringify({ project: projectKey, models }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return path;
}

function staleError(projectKey: string): CommandFailedError {
  return new CommandFailedError(
    `The intended architecture of '${projectKey}' changed since the file was read; nothing was changed.`,
    {
      remediationHint: `Run 'sonar architecture get intended --project ${projectKey} --format json' again and reapply your edits.`,
    },
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
