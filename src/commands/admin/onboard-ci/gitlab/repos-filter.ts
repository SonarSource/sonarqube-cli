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

import { readFileSync } from 'node:fs';

import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import type { GitLabRepo } from '@/core/gitlab/client.ts';
import type { Console } from '@/core/ui/console.ts';

import type { OnboardCiGitlabOptions } from './types.ts';

export type RepoEntriesSource = '--repos' | '--repos-file';

/** Splits a comma-separated `--repos` value; every entry must be non-empty once trimmed. */
export function parseReposOption(value: string): string[] {
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0)) {
    throw new InvalidOptionError(
      `Invalid --repos value '${value}'. Provide comma-separated repository paths relative to --group, without empty entries.`,
    );
  }
  return entries;
}

export function readReposFileEntries(reposFile: string): Set<string> {
  let fileContent: string;
  try {
    fileContent = readFileSync(reposFile, 'utf8');
  } catch {
    throw new CommandFailedError(`--repos-file: file not found or unreadable: ${reposFile}`, {
      exitCode: 2,
    });
  }
  return new Set(
    fileContent
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );
}

/** The repositories explicitly selected via `--repos` or `--repos-file`, or undefined when neither is set. */
export function resolveSelectedRepoEntries(
  options: Pick<OnboardCiGitlabOptions, 'repos' | 'reposFile'>,
): { entries: Set<string>; source: RepoEntriesSource } | undefined {
  if (options.repos !== undefined) {
    return { entries: new Set(parseReposOption(options.repos)), source: '--repos' };
  }
  if (options.reposFile) {
    return { entries: readReposFileEntries(options.reposFile), source: '--repos-file' };
  }
  return undefined;
}

export function filterReposByEntries<T extends GitLabRepo>(
  allRepos: GitLabRepo[],
  repos: T[],
  entries: Set<string>,
  source: RepoEntriesSource,
  group: string,
  console: Console,
): T[] {
  const groupPrefix = `${group}/`;
  const relativePath = (r: GitLabRepo) =>
    r.path_with_namespace.startsWith(groupPrefix)
      ? r.path_with_namespace.slice(groupPrefix.length)
      : r.path_with_namespace;

  for (const e of entries) {
    if (repos.some((r) => relativePath(r) === e)) continue;
    if (allRepos.some((r) => relativePath(r) === e)) {
      console.warn(
        `→ '${e}' from ${source} is not eligible (empty repository or pending deletion), skipped`,
      );
    } else {
      console.warn(`→ '${e}' from ${source} not found in group, skipped`);
    }
  }

  return repos.filter((r) => entries.has(relativePath(r)));
}
