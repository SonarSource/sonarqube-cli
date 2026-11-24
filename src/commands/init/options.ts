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

import { isAbsolute, posix } from 'node:path';

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import { isValidProjectKey } from '@/core/project-key.ts';
import type { Console } from '@/core/ui/console.ts';

const MAX_NAME_LENGTH = 255;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function validateProjectKey(key: string, label = '--project'): string {
  const trimmed = key.trim();
  if (!isValidProjectKey(trimmed)) {
    throw new InvalidOptionError(
      `${label} must contain only letters, digits, "-", "_", "." and ":", with at least one non-digit.`,
    );
  }
  return trimmed;
}

export function validateProjectName(name: string, label = '--name'): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH || CONTROL_CHARACTERS.test(trimmed)) {
    throw new InvalidOptionError(
      `${label} must be non-empty, at most ${MAX_NAME_LENGTH} characters, and free of control characters.`,
    );
  }
  return trimmed;
}

/**
 * The onboarding path the caller consented to up front. It answers the matching prompts, and is
 * the only consent a non-interactive run has: without it, nothing is linked or bound.
 */
export type InitIntent =
  /** Link an existing project: the one found for the directory, or `projectKey`. */
  | { kind: 'link'; projectKey?: string }
  /** Create a project bound to the repository. */
  | { kind: 'bind' };

export function validateIntentOptions(rawOptions: {
  link?: string | boolean;
  bind?: boolean;
  monorepo?: boolean;
}): InitIntent | undefined {
  if (rawOptions.link !== undefined && rawOptions.bind) {
    throw new InvalidOptionError(
      '--link, --bind cannot be combined: each picks a different onboarding path.',
    );
  }
  if (rawOptions.monorepo && typeof rawOptions.link === 'string') {
    assertMonorepoLinkKey();
  }
  if (rawOptions.bind) {
    return { kind: 'bind' };
  }
  if (rawOptions.link === undefined) {
    return undefined;
  }
  return typeof rawOptions.link === 'string'
    ? { kind: 'link', projectKey: validateProjectKey(rawOptions.link, '--link') }
    : { kind: 'link' };
}

/** A monorepo run maps many roots, so one project key cannot serve them. */
function assertMonorepoLinkKey(): never {
  throw new InvalidOptionError(
    '--link <key> does not apply with --monorepo: one key cannot serve several roots.',
    'Use a bare --link, and name each root with --root <path>=<project key>.',
  );
}

/** An intent only goes unused when the directory was already linked, which is never changed. */
export function warnIgnoredIntent(intent: InitIntent | undefined, console: Console): void {
  if (!intent) {
    return;
  }
  const relink =
    intent.kind === 'link' && intent.projectKey
      ? ` To link it to '${intent.projectKey}' instead, run 'sonar link ${intent.projectKey}'.`
      : '';
  console.warn(
    `--${intent.kind} ignored: this directory is already linked in ${SHARED_PROJECT_CONFIG_FILE_NAME}.${relink}`,
  );
}

/** A project root named on the command line: a directory of the repository, and its project's key unless left to be generated. */
export interface MonorepoRootOption {
  /** Forward-slash path relative to the repository root, without a leading `./`. */
  path: string;
  projectKey?: string;
}

/** Commander accumulator for the repeatable `--root` option. */
export function collectRoot(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseMonorepoRoot(raw: string): MonorepoRootOption {
  // A key has no "=" or separator, a path may: only a last "=" followed by a key-like tail names one.
  const separator = raw.lastIndexOf('=');
  const keyed = separator >= 0 && !/[\\/]/.test(raw.slice(separator + 1));
  const rawPath = (keyed ? raw.slice(0, separator) : raw).trim();
  if (!rawPath || CONTROL_CHARACTERS.test(rawPath) || isAbsolute(rawPath)) {
    throw new InvalidOptionError(
      `--root must be <path> or <path>=<project key>, with a path relative to the repository root (got "${raw}").`,
    );
  }
  const path = posix.normalize(rawPath.replaceAll('\\', '/')).replace(/\/$/, '');
  if (path === '..' || path.startsWith('../')) {
    throw new InvalidOptionError(`--root path "${rawPath}" must stay inside the repository.`);
  }
  return {
    path,
    projectKey: keyed ? validateProjectKey(raw.slice(separator + 1), '--root key') : undefined,
  };
}

/** Parses every `--root`, rejecting a directory or a key named twice. */
export function parseMonorepoRoots(raw: readonly string[] | undefined): MonorepoRootOption[] {
  const roots = (raw ?? []).map(parseMonorepoRoot);
  for (const [index, root] of roots.entries()) {
    const earlier = roots.slice(0, index);
    if (earlier.some(({ path }) => path === root.path)) {
      throw new InvalidOptionError(`--root names "${root.path}" more than once.`);
    }
    if (root.projectKey && earlier.some(({ projectKey }) => projectKey === root.projectKey)) {
      throw new InvalidOptionError(`--root names project '${root.projectKey}' more than once.`);
    }
  }
  return roots;
}
