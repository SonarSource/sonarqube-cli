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

const MAX_NAME_LENGTH = 255;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** The `sonar init` flags that only apply when a project is created without repository binding. */
export interface UnboundNewFlags {
  projectKey?: string;
  name?: string;
  visibility?: ProjectVisibility;
}

export function validateProjectKey(key: string): string {
  const trimmed = key.trim();
  if (!isValidProjectKey(trimmed)) {
    throw new InvalidOptionError(
      '--project-key must contain only letters, digits, "-", "_", "." and ":", with at least one non-digit.',
    );
  }
  return trimmed;
}

export function validateProjectName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH || CONTROL_CHARACTERS.test(trimmed)) {
    throw new InvalidOptionError(
      `--name must be non-empty, at most ${MAX_NAME_LENGTH} characters, and free of control characters.`,
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
  projectKey?: string;
  name?: string;
  visibility?: string;
}): UnboundNewFlags {
  return {
    projectKey:
      options.projectKey === undefined ? undefined : validateProjectKey(options.projectKey),
    name: options.name === undefined ? undefined : validateProjectName(options.name),
    visibility:
      options.visibility === undefined ? undefined : validateVisibility(options.visibility),
  };
}

export function warnIgnoredUnboundNewFlags(flags: UnboundNewFlags, console: Console): void {
  const ignored = [
    flags.projectKey === undefined ? null : '--project-key',
    flags.name === undefined ? null : '--name',
    flags.visibility === undefined ? null : '--visibility',
  ].filter((flag) => flag !== null);
  if (ignored.length > 0) {
    console.warn(
      `${ignored.join(', ')} ignored: they only apply when a new project is created without repository binding.`,
    );
  }
}
