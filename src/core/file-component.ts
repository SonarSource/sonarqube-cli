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

// Resolves a user-supplied file value to its exact SonarQube component key

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { ComponentsClient } from '@/core/server/components.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';

/**
 * Resolve a --file value to its exact SonarQube component key. Throws InvalidOptionError
 * when it doesn't resolve to exactly one file or directory.
 */
export async function resolveFileComponentKey(
  client: SonarHttpClient,
  projectKey: string,
  file: string,
  scope: { branch?: string; pullRequest?: string } = {},
): Promise<string> {
  const componentsClient = new ComponentsClient(client);
  const cleanedFile = normalizeFileValue(file);

  if (looksLikePath(file)) {
    return resolveByExactPath(componentsClient, projectKey, file, cleanedFile, scope);
  } else {
    return resolveByNameAlone(componentsClient, projectKey, file, cleanedFile, scope);
  }
}

async function resolveByExactPath(
  componentsClient: ComponentsClient,
  projectKey: string,
  file: string,
  path: string,
  scope: { branch?: string; pullRequest?: string },
): Promise<string> {
  const componentKey = `${projectKey}:${path}`;
  if (!(await componentsClient.componentExists(componentKey, scope).orThrow())) {
    throw notFoundError(file, projectKey);
  }
  return componentKey;
}

async function resolveByNameAlone(
  componentsClient: ComponentsClient,
  projectKey: string,
  file: string,
  name: string,
  scope: { branch?: string; pullRequest?: string },
): Promise<string> {
  // ps=1 is enough — paging.total isn't affected by ps.
  const result = await componentsClient
    .searchComponentsByName(projectKey, name, 'FIL,UTS,DIR', 1, scope)
    .orThrow();
  const total = result.paging.total;

  if (total === 0) {
    throw notFoundError(file, projectKey);
  }
  if (total > 1) {
    throw new InvalidOptionError(
      `'${file}' matches ${total} files or directories in project '${projectKey}'.`,
      'Use the full path from the project root instead of just the file name.',
    );
  }

  return `${projectKey}:${result.components[0].path}`;
}

function notFoundError(file: string, projectKey: string): InvalidOptionError {
  return new InvalidOptionError(
    `No file or directory matching '${file}' was found in project '${projectKey}'.`,
    'Check the spelling, or pass the full path relative to the project root.',
  );
}

function looksLikePath(file: string): boolean {
  return file.includes('/') || file.includes('\\');
}

/**
 * Normalizes Windows-style `\` separators to `/` and strips a shell-completed trailing
 * slash, so a Windows path or a tab-completed directory resolves the same as a Unix path.
 */
function normalizeFileValue(file: string): string {
  let value = file.replaceAll('\\', '/');
  if (value.startsWith('./')) {
    value = value.slice(2);
  } else if (value.startsWith('/')) {
    value = value.slice(1);
  }
  if (value.endsWith('/')) {
    value = value.slice(0, -1);
  }
  return value;
}
