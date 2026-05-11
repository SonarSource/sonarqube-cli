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

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AppliedResource, IntegrationContext, MaybePromise } from '../types';

const EXECUTABLE_FILE_MODE = 0o755;

export type PathResolver = string | ((context: IntegrationContext) => MaybePromise<string>);

export interface BaseResourceOptions {
  id: string;
  displayName?: string;
  version?: string;
}

export interface ResourceDeclaration {
  id: string;
  displayName?: string;
  resourceType: string;
  version?: string;
  apply: (context: IntegrationContext) => MaybePromise<AppliedResource>;
  isApplied: (context: IntegrationContext) => MaybePromise<boolean>;
}

export async function resolvePath(
  context: IntegrationContext,
  path: PathResolver,
): Promise<string> {
  return typeof path === 'function' ? path(context) : path;
}

export async function writeFileIfChanged(
  path: string,
  content: string,
  executable?: boolean,
): Promise<void> {
  const mode = executable ? EXECUTABLE_FILE_MODE : undefined;
  if (existsSync(path)) {
    const existing = await readFile(path, 'utf-8');
    if (existing === content) {
      if (mode !== undefined) {
        await chmod(path, mode);
      }
      return;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, mode === undefined ? undefined : { mode });
}

export async function readTextFile(path: string): Promise<string | undefined> {
  if (!existsSync(path)) {
    return undefined;
  }
  return readFile(path, 'utf-8');
}
