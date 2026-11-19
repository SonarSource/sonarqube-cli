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
import type { ProjectVisibility } from '@/core/server/projects.ts';
import type { Console } from '@/core/ui/console.ts';

import { parseScannerProperties } from './scan/scanner-property.ts';
import type { ScanOptions } from './steps/scan.ts';

const MAX_NAME_LENGTH = 255;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
/** Make the scanner print its properties, which a detached run's unredacted log would keep. */
const DETACH_FORBIDDEN_PROPERTIES = ['sonar.verbose', 'sonar.log.level'];

/** The `sonar init` options that only apply when a project is created without repository binding. */
export interface UnboundNewOptions {
  projectKey?: string;
  name?: string;
  visibility?: ProjectVisibility;
}

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

export function validateVisibility(visibility: string): ProjectVisibility {
  if (visibility === 'private' || visibility === 'public') {
    return visibility;
  }
  throw new InvalidOptionError('--visibility must be private or public.');
}

export function validateUnboundNewOptions(rawOptions: {
  project?: string;
  name?: string;
  visibility?: string;
}): UnboundNewOptions {
  return {
    projectKey:
      rawOptions.project === undefined ? undefined : validateProjectKey(rawOptions.project),
    name: rawOptions.name === undefined ? undefined : validateProjectName(rawOptions.name),
    visibility:
      rawOptions.visibility === undefined ? undefined : validateVisibility(rawOptions.visibility),
  };
}

/**
 * The onboarding path the caller consented to up front. It answers the matching prompts, and is
 * the only consent a non-interactive run has: without it, nothing is linked, bound or created.
 */
export type InitIntent =
  /** Link an existing project: the one found for the directory, or `projectKey`. */
  | { kind: 'link'; projectKey?: string }
  /** Create a project bound to the repository. */
  | { kind: 'bind' }
  /** Create a project without repository binding. */
  | { kind: 'create' };

export function validateIntentOptions(rawOptions: {
  link?: string | boolean;
  bind?: boolean;
  create?: boolean;
  monorepo?: boolean;
}): InitIntent | undefined {
  const given = [
    rawOptions.link === undefined ? null : '--link',
    rawOptions.bind ? '--bind' : null,
    rawOptions.create ? '--create' : null,
  ].filter((option) => option !== null);
  if (given.length > 1) {
    throw new InvalidOptionError(
      `${given.join(', ')} cannot be combined: each picks a different onboarding path.`,
    );
  }
  if (rawOptions.monorepo) {
    assertMonorepoIntent(rawOptions);
  }
  if (rawOptions.bind) {
    return { kind: 'bind' };
  }
  if (rawOptions.create) {
    return { kind: 'create' };
  }
  if (rawOptions.link === undefined) {
    return undefined;
  }
  return typeof rawOptions.link === 'string'
    ? { kind: 'link', projectKey: validateProjectKey(rawOptions.link, '--link') }
    : { kind: 'link' };
}

/** A monorepo run maps many roots, so only the modes that need no single project key or binding apply. */
function assertMonorepoIntent(rawOptions: { link?: string | boolean; bind?: boolean }): void {
  if (rawOptions.bind) {
    throw new InvalidOptionError(
      '--bind does not apply with --monorepo: a repository binds to a single project.',
      'Name the roots to onboard with --root instead.',
    );
  }
  if (typeof rawOptions.link === 'string') {
    throw new InvalidOptionError(
      '--link <key> does not apply with --monorepo: one key cannot serve several roots.',
      'Use a bare --link, and name each root with --root <path>=<project key>.',
    );
  }
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

export function warnIgnoredUnboundNewOptions(options: UnboundNewOptions, console: Console): void {
  const ignored = [
    options.projectKey === undefined ? null : '--project',
    options.name === undefined ? null : '--name',
    options.visibility === undefined ? null : '--visibility',
  ].filter((option) => option !== null);
  if (ignored.length > 0) {
    console.warn(
      `${ignored.join(', ')} ignored: only applicable when a new project is created without repository binding.`,
    );
  }
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

export function validateScanOptions(options: {
  scan?: boolean;
  scannerProperty?: string[];
  verbose?: boolean;
  detach?: boolean;
}): ScanOptions {
  if (options.detach && options.verbose) {
    throw new InvalidOptionError(
      '--detach cannot be combined with --verbose: a background scanner writes to its log file only.',
    );
  }
  const scannerProperties = parseScannerProperties(options.scannerProperty);
  const verboseProperty = DETACH_FORBIDDEN_PROPERTIES.find((key) => scannerProperties.has(key));
  if (options.detach && verboseProperty) {
    throw new InvalidOptionError(
      `--detach cannot be combined with --scanner-property ${verboseProperty}: a background scanner's log is not redacted.`,
    );
  }
  return {
    scannerProperties,
    verbose: options.verbose === true,
    detach: options.detach === true,
    scan: options.scan === true,
  };
}

/** A dry run never starts the first analysis, so the options that shape it can only be a mistake. */
export function assertDryRunOptions(flags: ScanOptions): void {
  const conflicting = [
    flags.scan ? '--scan' : null,
    flags.detach ? '--detach' : null,
    flags.verbose ? '--verbose' : null,
    flags.scannerProperties.size === 0 ? null : '--scanner-property',
  ].filter((flag) => flag !== null);
  if (conflicting.length > 0) {
    throw new InvalidOptionError(
      `${conflicting.join(', ')} cannot be combined with --dry-run: a dry run starts no analysis.`,
    );
  }
}

/** Warns when scan-only flags were given but no scan ran. Never names a property value. */
export function warnIgnoredScanOptions(flags: ScanOptions, console: Console): void {
  const ignored = [
    flags.scannerProperties.size === 0 ? null : '--scanner-property',
    flags.detach ? '--detach' : null,
    flags.verbose ? '--verbose' : null,
    flags.scan ? '--scan' : null,
  ].filter((flag) => flag !== null);
  if (ignored.length > 0) {
    console.warn(`${ignored.join(', ')} ignored: only applicable when the first analysis runs.`);
  }
}
