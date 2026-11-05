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

import { InvalidOptionError } from '@/core/commands/command-error.ts';
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

export function validateProjectKey(key: string): string {
  const trimmed = key.trim();
  if (!isValidProjectKey(trimmed)) {
    throw new InvalidOptionError(
      '--project must contain only letters, digits, "-", "_", "." and ":", with at least one non-digit.',
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

export function validateScanOptions(options: {
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
  };
}

/** Warns when scan-only flags were given but no scan ran. Never names a property value. */
export function warnIgnoredScanOptions(flags: ScanOptions, console: Console): void {
  const ignored = [
    flags.scannerProperties.size === 0 ? null : '--scanner-property',
    flags.detach ? '--detach' : null,
  ].filter((flag) => flag !== null);
  if (ignored.length > 0) {
    console.warn(`${ignored.join(', ')} ignored: only applicable when the first analysis runs.`);
  }
}
