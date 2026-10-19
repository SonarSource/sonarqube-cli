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

// Saving an intended architecture safely without a transactional replace: refuse a stale
// base, back up, delete and create, then attempt recovery only after checking the saved state.

import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CommandFailedError } from '@/core/commands/command-error.ts';

import type { ArchitectureApi, IntendedArchitecture } from './architecture-api.ts';
import { diffIntended, type IntendedDiff, isEmptyDiff } from './intended-diff.ts';
import { revisionOf } from './intended-model.ts';
import type { IntendedFile } from './intended-validation.ts';

export type SetIntendedMode = 'dry-run' | 'unchanged' | 'created' | 'replaced-by-fallback';

export interface SetIntendedResult {
  mode: SetIntendedMode;
  diff: IntendedDiff;
  /** Set when the saved model was backed up before being deleted. */
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
  if (!isEmptyDiff(diff) && (current.length > 1 || next.length > 1)) {
    throw new CommandFailedError(
      'The public API can create only one intended architecture perspective. Changing a multi-perspective model cannot be safely applied or restored; nothing was changed.',
    );
  }
  if (options.dryRun) return { mode: 'dry-run', diff, unchecked };
  if (isEmptyDiff(diff)) return { mode: 'unchanged', diff, unchecked };

  if (current.length === 0) {
    try {
      await api.createIntended(next);
    } catch (createError) {
      try {
        if (revisionOf(await api.getIntended()) === revisionOf(next)) {
          return { mode: 'created', diff, unchecked };
        }
      } catch (readError) {
        throw new CommandFailedError(
          `Creating the intended architecture failed and its result could not be verified. The server state is unknown. Create failed: ${messageOf(createError)}\nRead failed: ${messageOf(readError)}`,
          { cause: createError },
        );
      }
      throw createError;
    }
    return { mode: 'created', diff, unchecked };
  }
  const backupPath = await writeBackup(options.backupDir, options.projectKey, current);
  if (revisionOf(await api.getIntended()) !== revisionOf(current)) {
    throw staleError(options.projectKey);
  }
  try {
    await api.deleteIntended();
  } catch (deleteError) {
    await recoverPrevious(api, current, backupPath, options.projectKey, deleteError);
    throw new CommandFailedError(
      `Deleting the intended architecture failed; the previous export was preserved or restored. ${messageOf(deleteError)}`,
      { cause: deleteError, remediationHint: `Backup kept at ${backupPath}` },
    );
  }
  let remaining: IntendedArchitecture[];
  try {
    remaining = await api.getIntended();
  } catch (readError) {
    throw recoveryError(
      backupPath,
      options.projectKey,
      'DELETE completed, but its result could not be verified.',
      readError,
    );
  }
  if (remaining.length > 0) {
    throw recoveryError(
      backupPath,
      options.projectKey,
      'The intended architecture is still present after DELETE.',
      'Automatic recovery stopped to avoid overwriting concurrent changes or unbacked legacy models.',
    );
  }
  if (next.length === 0) {
    return { mode: 'replaced-by-fallback', diff, backupPath, unchecked };
  }
  try {
    await api.createIntended(next);
  } catch (createError) {
    let saved: IntendedArchitecture[];
    try {
      saved = await api.getIntended();
    } catch (readError) {
      throw recoveryError(backupPath, options.projectKey, createError, readError);
    }
    if (revisionOf(saved) === revisionOf(next)) {
      return { mode: 'replaced-by-fallback', diff, backupPath, unchecked };
    }
    await recoverPrevious(api, current, backupPath, options.projectKey, createError, saved);
    throw new CommandFailedError(
      `Saving the new intended architecture failed; the previous export was preserved or restored. ${messageOf(createError)}`,
      { cause: createError, remediationHint: `Backup kept at ${backupPath}` },
    );
  }
  return { mode: 'replaced-by-fallback', diff, backupPath, unchecked };
}

/** The saved models with the file's language replaced by the file's model (or removed). */
function withLanguage(current: IntendedArchitecture[], file: IntendedFile): IntendedArchitecture[] {
  const others = current.filter(({ language }) => language !== file.language);
  return [...others, ...file.models];
}

async function recoverPrevious(
  api: ArchitectureApi,
  previous: IntendedArchitecture[],
  backupPath: string,
  projectKey: string,
  operationError: unknown,
  observed?: IntendedArchitecture[],
): Promise<void> {
  try {
    const saved = observed ?? (await api.getIntended());
    if (revisionOf(saved) === revisionOf(previous)) return;
    if (saved.length > 0) {
      throw new CommandFailedError(
        'The saved architecture differs from the backup; automatic recovery stopped to avoid overwriting concurrent changes.',
      );
    }
    try {
      await api.createIntended(previous);
    } catch (restoreError) {
      if (revisionOf(await api.getIntended()) !== revisionOf(previous)) throw restoreError;
    }
  } catch (restoreError) {
    throw recoveryError(backupPath, projectKey, operationError, restoreError);
  }
}

function recoveryError(
  backupPath: string,
  projectKey: string,
  operationError: unknown,
  restoreError: unknown,
): CommandFailedError {
  return new CommandFailedError(
    [
      'The architecture write failed, and automatic recovery could not be completed. The current server state may have changed; inspect it before restoring.',
      `The previous export is saved in ${backupPath}`,
      `Write failed: ${messageOf(operationError)}`,
      `Recovery failed: ${messageOf(restoreError)}`,
    ].join('\n'),
    {
      cause: restoreError,
      remediationHint: `Restore it with: sonar architecture set intended --project ${projectKey} --file ${backupPath}`,
    },
  );
}

async function writeBackup(
  backupDir: string,
  projectKey: string,
  models: IntendedArchitecture[],
): Promise<string> {
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  if (!(await lstat(backupDir)).isDirectory()) {
    throw new CommandFailedError('The architecture backup path must be a real directory.');
  }
  await chmod(backupDir, 0o700);
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
