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

import yaml from 'js-yaml';

import {
  PatchResource,
  type PatchResourceOptions,
  type RemovableResource,
  RemoveablePatchResource,
  type RemoveablePatchResourceOptions,
  type ResourceDeclaration,
  type ResourceIdentity,
} from './common';

export interface YamlPatchOptions<TDoc = unknown> extends PatchResourceOptions<TDoc> {
  defaultValue?: TDoc;
}

export function yamlPatch<TDoc = unknown>(options: YamlPatchOptions<TDoc>): ResourceDeclaration {
  return new YamlPatch(options);
}

export class YamlPatch<TDoc = unknown> extends PatchResource<YamlPatchOptions<TDoc>, TDoc> {
  readonly resourceType = 'yaml-patch';

  constructor(options: YamlPatchOptions<TDoc>) {
    super(
      options,
      new YamlRemoveablePatchResource({
        id: options.id,
        version: options.version,
        targetPath: options.targetPath,
        removePatch: options.removePatch,
        defaultValue: options.defaultValue,
      }),
    );
  }

  protected readDocument(path: string): Promise<TDoc> {
    return readYaml(path).then((doc) => doc as TDoc);
  }

  protected serializeDocument(document: unknown): string {
    return yaml.dump(document, { lineWidth: -1 });
  }
}

async function readYaml(path: string): Promise<unknown> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    return yaml.load(await readFile(path, 'utf-8')) ?? {};
  } catch {
    return {};
  }
}

export type YamlPatchRemoverOptions<TDoc = unknown> = RemoveablePatchResourceOptions<TDoc>;

export function yamlPatchRemover<TDoc = unknown>(
  options: YamlPatchRemoverOptions<TDoc>,
): ResourceIdentity & RemovableResource {
  return new YamlRemoveablePatchResource(options);
}

class YamlRemoveablePatchResource<TDoc = unknown> extends RemoveablePatchResource<TDoc> {
  readonly resourceType = 'yaml-patch';

  protected readDocument(path: string): Promise<TDoc> {
    return readYaml(path).then((doc) => doc as TDoc);
  }

  protected serializeDocument(document: unknown): string {
    return yaml.dump(document, { lineWidth: -1 });
  }
}
