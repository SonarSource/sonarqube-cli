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
import { readFile } from 'node:fs/promises';

import { CommandFailedError } from '../../../../_common/error';
import type { IntegrationContext, MaybePromise } from '../types';
import { PatchResource, type PatchResourceOptions, type ResourceDeclaration } from './common';

export interface JsonPatchOptions extends PatchResourceOptions {
  defaultValue?: unknown;
  patch: (document: unknown, context: IntegrationContext) => MaybePromise<unknown>;
}

export function jsonPatch(options: JsonPatchOptions): ResourceDeclaration {
  return new JsonPatch(options);
}

export class JsonPatch extends PatchResource<JsonPatchOptions> {
  readonly resourceType = 'json-patch';

  protected async renderContent(path: string, context: IntegrationContext): Promise<string> {
    const document = await readJson(path, this.options.defaultValue ?? {});
    const updated = await this.options.patch(document, context);
    return `${JSON.stringify(updated ?? document, null, 2)}\n`;
  }
}

async function readJson(path: string, defaultValue: unknown): Promise<unknown> {
  if (!existsSync(path)) {
    return defaultValue;
  }
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as unknown;
  } catch {
    throw new CommandFailedError(
      `${path} contains invalid JSON. Please fix or delete it and re-run.`,
    );
  }
}
