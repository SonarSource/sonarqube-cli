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

import { CommandFailedError } from '../../../../_common/error.ts';
import {
  PatchResource,
  type PatchResourceOptions,
  type RemovableResource,
  RemoveablePatchResource,
  type RemoveablePatchResourceOptions,
  type ResourceDeclaration,
  type ResourceIdentity,
} from './common.ts';

export interface JsonPatchOptions<TDoc = unknown> extends PatchResourceOptions<TDoc> {
  defaultValue?: TDoc;
}

export function jsonPatch<TDoc = unknown>(options: JsonPatchOptions<TDoc>): ResourceDeclaration {
  return new JsonPatch(options);
}

export class JsonPatch<TDoc = unknown> extends PatchResource<JsonPatchOptions<TDoc>, TDoc> {
  readonly resourceType = 'json-patch';

  constructor(options: JsonPatchOptions<TDoc>) {
    super(
      options,
      new JsonRemoveablePatchResource({
        id: options.id,
        version: options.version,
        targetPath: options.targetPath,
        removePatch: options.removePatch,
        defaultValue: options.defaultValue,
      }),
    );
  }

  protected readDocument(path: string): Promise<TDoc> {
    return readJson(path, this.options.defaultValue ?? {}) as Promise<TDoc>;
  }

  protected serializeDocument(document: unknown): string {
    return `${JSON.stringify(document, null, 2)}\n`;
  }
}

async function readJson(path: string, defaultValue: unknown): Promise<unknown> {
  if (!existsSync(path)) {
    return defaultValue;
  }
  const raw = await readFile(path, 'utf-8');
  if (raw.trim().length === 0) {
    return defaultValue;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new CommandFailedError(
      `${path} contains invalid JSON. Please fix or delete it and re-run.`,
    );
  }
}

export type JsonPatchRemoverOptions<TDoc = unknown> = RemoveablePatchResourceOptions<TDoc>;

export function jsonPatchRemover<TDoc = unknown>(
  options: JsonPatchRemoverOptions<TDoc>,
): ResourceIdentity & RemovableResource {
  return new JsonRemoveablePatchResource(options);
}

class JsonRemoveablePatchResource<TDoc = unknown> extends RemoveablePatchResource<TDoc> {
  readonly resourceType = 'json-patch';

  protected readDocument(path: string): Promise<TDoc> {
    return readJson(path, {}).then((doc) => doc as TDoc);
  }

  protected serializeDocument(document: unknown): string {
    return `${JSON.stringify(document, null, 2)}\n`;
  }
}
