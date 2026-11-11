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

// Parsing and validation of the project list `sonar import --monorepo` binds to one repository.

import { readFileSync } from 'node:fs';

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { isValidProjectKey, PROJECT_KEY_MAX_LENGTH } from '@/core/project-key.ts';

import type { ImportOptions } from './types';

export interface MonorepoProject {
  projectKey: string;
  projectName: string;
}

const PROJECT_NAME_MAX_LENGTH = 255;

const KEY_RULES_HINT = `A project key has letters, digits and "-_.:", at most ${PROJECT_KEY_MAX_LENGTH} characters, and at least one non-digit.`;

/**
 * Collects a repeatable `--project <key>[=<name>]`; each value may be comma-separated. Duplicates
 * are kept so `assertValid` can report them.
 */
export function collectProjectKeyOption(value: string, previous: string[] = []): string[] {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...previous, ...entries];
}

export interface MonorepoImport {
  /** The repository slug given to `--monorepo`. */
  repo: string;
  projects: MonorepoProject[];
}

/**
 * Validates the `--monorepo <slug>` flag family and returns what to import, or `undefined` when
 * the run is an ordinary import. Runs before any request so a bad invocation fails immediately.
 */
export function resolveMonorepoImport(options: ImportOptions): MonorepoImport | undefined {
  const flagEntries = options.project ?? [];
  const givesProjects = flagEntries.length > 0 || options.projectsFile !== undefined;

  if (options.monorepo === undefined) {
    if (givesProjects) {
      throw new InvalidOptionError(
        '--project and --projects-file require --monorepo.',
        'Add --monorepo <slug> to bind several projects to one repository.',
      );
    }
    return undefined;
  }

  if (options.repo?.length || options.all || options.regex) {
    throw new InvalidOptionError(
      '--monorepo cannot be combined with --repo, --all or --regex.',
      'Pass the repository to --monorepo instead, e.g. --monorepo my-org/my-repo.',
    );
  }
  const repo = options.monorepo.trim();
  if (repo === '' || repo.includes(',')) {
    throw new InvalidOptionError(
      '--monorepo takes exactly one repository slug.',
      'A monorepo import binds several projects to a single repository, e.g. --monorepo my-org/my-repo.',
    );
  }

  const projects = [
    ...flagEntries.map(parseProjectEntry),
    ...(options.projectsFile === undefined ? [] : readProjectsFile(options.projectsFile)),
  ];
  if (projects.length === 0) {
    throw new InvalidOptionError(
      '--monorepo requires at least one project.',
      'Pass --project <key>[=<name>] (repeatable) or --projects-file <file.json>.',
    );
  }

  assertValid(projects);
  return { repo, projects };
}

function parseProjectEntry(entry: string): MonorepoProject {
  const separator = entry.indexOf('=');
  if (separator === -1) {
    return { projectKey: entry, projectName: entry };
  }
  const projectKey = entry.slice(0, separator).trim();
  const projectName = entry.slice(separator + 1).trim();
  return { projectKey, projectName: projectName === '' ? projectKey : projectName };
}

function readProjectsFile(path: string): MonorepoProject[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new InvalidOptionError(
      `Could not read --projects-file '${path}': ${error instanceof Error ? error.message : String(error)}`,
      'Pass a JSON file shaped like [{ "projectKey": "org_repo_api", "projectName": "API" }].',
    );
  }
  if (!Array.isArray(parsed)) {
    throw new InvalidOptionError(
      `--projects-file '${path}' must contain a JSON array.`,
      'Use the shape [{ "projectKey": "org_repo_api", "projectName": "API" }].',
    );
  }
  return parsed.map((entry, index) => parseFileEntry(entry, index, path));
}

function parseFileEntry(entry: unknown, index: number, path: string): MonorepoProject {
  const candidate = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
    string,
    unknown
  >;
  const { projectKey, projectName } = candidate;
  if (typeof projectKey !== 'string' || projectKey.trim() === '') {
    throw new InvalidOptionError(
      `--projects-file '${path}': entry ${index + 1} has no "projectKey".`,
      'Every entry needs a string "projectKey" and may have a string "projectName".',
    );
  }
  if (projectName !== undefined && typeof projectName !== 'string') {
    throw new InvalidOptionError(
      `--projects-file '${path}': "projectName" of entry ${index + 1} must be a string.`,
      'Remove it to use the project key as the display name.',
    );
  }
  const key = projectKey.trim();
  return { projectKey: key, projectName: projectName?.trim() || key };
}

function assertValid(projects: MonorepoProject[]): void {
  const seen = new Set<string>();
  for (const { projectKey, projectName } of projects) {
    if (!isValidProjectKey(projectKey)) {
      throw new InvalidOptionError(`'${projectKey}' is not a valid project key.`, KEY_RULES_HINT);
    }
    if (projectName.length > PROJECT_NAME_MAX_LENGTH) {
      throw new InvalidOptionError(
        `The name of project '${projectKey}' is longer than ${PROJECT_NAME_MAX_LENGTH} characters.`,
        'Shorten the display name.',
      );
    }
    if (seen.has(projectKey)) {
      throw new InvalidOptionError(
        `Project key '${projectKey}' is given more than once.`,
        'Each project in a monorepo needs its own key.',
      );
    }
    seen.add(projectKey);
  }
}
