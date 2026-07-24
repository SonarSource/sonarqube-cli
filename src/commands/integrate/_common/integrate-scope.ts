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

import { CommandFailedError } from '@/commands/_common/error.ts';
import { normalizePath } from '@/core/io/fs-utils.ts';
import type { IntegrationScope } from '@/core/state/state.ts';
import { blank, info, selectPrompt } from '@/core/ui';

export interface IntegrateScopeOptions {
  global?: boolean;
  nonInteractive?: boolean;
  /** Project install root shown in the interactive scope prompt and non-interactive default line. */
  projectRoot?: string;
  /** Explicit project key (e.g. `--project`); implies project scope and skips the prompt. */
  projectKey?: string;
}

function formatNonInteractiveDefaultInfo(projectRoot: string | undefined): string {
  if (projectRoot === undefined) {
    return 'No install scope specified; defaulting to this project.';
  }
  return `No install scope specified; defaulting to this project (${normalizePath(projectRoot)}).`;
}

export function buildProjectScopeLabel(projectRoot: string): string {
  return `This project (${normalizePath(projectRoot)})`;
}

/**
 * Resolve whether an integrate command should install at project or global scope.
 *
 * When `--global` is set, scope is global. When an explicit project key was
 * supplied, scope is project (the prompt is skipped). When `--non-interactive`
 * is set without `--global`, scope defaults to project with an info line.
 * Otherwise the user is prompted to choose.
 */
export async function resolveIntegrateScope(
  options: IntegrateScopeOptions,
): Promise<IntegrationScope> {
  if (options.global === true) {
    return 'global';
  }

  if (options.projectKey) {
    return 'project';
  }

  if (options.nonInteractive) {
    info(formatNonInteractiveDefaultInfo(options.projectRoot));
    return 'project';
  }

  const projectLabel =
    options.projectRoot === undefined
      ? 'This project (current directory)'
      : buildProjectScopeLabel(options.projectRoot);

  const choice = await selectPrompt<IntegrationScope>('Where should SonarQube be integrated?', [
    {
      value: 'project',
      label: projectLabel,
    },
    {
      value: 'global',
      label: 'Global (user home — applies across projects)',
    },
  ]);
  if (choice === null) {
    throw new CommandFailedError('Installation cancelled');
  }
  blank();
  return choice;
}

export function isGlobalIntegrateScope(scope: IntegrationScope): boolean {
  return scope === 'global';
}
