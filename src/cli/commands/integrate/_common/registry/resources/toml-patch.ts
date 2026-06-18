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

import { parse, stringify } from 'smol-toml';

import { CommandFailedError } from '../../../../_common/error';
import {
  PatchResource,
  type PatchResourceOptions,
  type RemovableResource,
  RemoveablePatchResource,
  type RemoveablePatchResourceOptions,
  type ResourceDeclaration,
  type ResourceIdentity,
} from './common';

export interface TomlPatchOptions extends PatchResourceOptions<Record<string, unknown>> {
  defaultValue?: Record<string, unknown>;
}

export function tomlPatch(options: TomlPatchOptions): ResourceDeclaration {
  return new TomlPatch(options);
}

export class TomlPatch extends PatchResource<TomlPatchOptions, Record<string, unknown>> {
  readonly resourceType = 'toml-patch';

  constructor(options: TomlPatchOptions) {
    super(
      options,
      new TomlRemoveablePatchResource({
        id: options.id,
        version: options.version,
        targetPath: options.targetPath,
        removePatch: options.removePatch,
      }),
    );
  }

  protected readDocument(path: string): Promise<Record<string, unknown>> {
    return readToml(path, this.options.defaultValue ?? {});
  }

  protected serializeDocument(document: unknown): string {
    return stringify(document);
  }
}

async function readToml(
  path: string,
  defaultValue: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!existsSync(path)) {
    return defaultValue;
  }
  const raw = await readFile(path, 'utf-8');
  if (raw.trim().length === 0) {
    return defaultValue;
  }
  try {
    return parse(raw);
  } catch {
    throw new CommandFailedError(
      `${path} contains invalid TOML. Please fix or delete it and re-run.`,
    );
  }
}

export type TomlPatchRemoverOptions = RemoveablePatchResourceOptions<Record<string, unknown>>;

export function tomlPatchRemover(
  options: TomlPatchRemoverOptions,
): ResourceIdentity & RemovableResource {
  return new TomlRemoveablePatchResource(options);
}

class TomlRemoveablePatchResource extends RemoveablePatchResource<Record<string, unknown>> {
  readonly resourceType = 'toml-patch';

  protected async readDocument(path: string): Promise<Record<string, unknown>> {
    return readToml(path, {});
  }

  protected serializeDocument(document: unknown): string {
    return stringify(document);
  }
}
