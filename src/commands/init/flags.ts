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
import type { ScanFlags } from './steps/scan.ts';

const MAX_NAME_LENGTH = 255;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
/** Make the scanner print its properties, which a detached run's unredacted log would keep. */
const DETACH_FORBIDDEN_PROPERTIES = ['sonar.verbose', 'sonar.log.level'];

/** The `sonar init` flags that only apply when a project is created without repository binding. */
export interface UnboundNewFlags {
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

export function validateUnboundNewFlags(options: {
  project?: string;
  name?: string;
  visibility?: string;
}): UnboundNewFlags {
  return {
    projectKey: options.project === undefined ? undefined : validateProjectKey(options.project),
    name: options.name === undefined ? undefined : validateProjectName(options.name),
    visibility:
      options.visibility === undefined ? undefined : validateVisibility(options.visibility),
  };
}

export function warnIgnoredUnboundNewFlags(flags: UnboundNewFlags, console: Console): void {
  const ignored = [
    flags.projectKey === undefined ? null : '--project',
    flags.name === undefined ? null : '--name',
    flags.visibility === undefined ? null : '--visibility',
  ].filter((flag) => flag !== null);
  if (ignored.length > 0) {
    console.warn(
      `${ignored.join(', ')} ignored: only applicable when a new project is created without repository binding.`,
    );
  }
}

export function validateScanFlags(options: {
  scannerProperty?: string[];
  verbose?: boolean;
  detach?: boolean;
}): ScanFlags {
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
export function warnIgnoredScanFlags(flags: ScanFlags, console: Console): void {
  const ignored = [
    flags.scannerProperties.size === 0 ? null : '--scanner-property',
    flags.detach ? '--detach' : null,
  ].filter((flag) => flag !== null);
  if (ignored.length > 0) {
    console.warn(`${ignored.join(', ')} ignored: only applicable when the first analysis runs.`);
  }
}
