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

import type { IntegrationContext, MaybePromise } from '../types';
import { PatchResource, type PatchResourceOptions, type ResourceDeclaration } from './common';

export interface YamlPatchOptions extends PatchResourceOptions {
  patch: (document: unknown, context: IntegrationContext) => MaybePromise<unknown>;
}

export function yamlPatch(options: YamlPatchOptions): ResourceDeclaration {
  return new YamlPatch(options);
}

export class YamlPatch extends PatchResource<YamlPatchOptions> {
  readonly resourceType = 'yaml-patch';

  protected async renderContent(path: string, context: IntegrationContext): Promise<string> {
    const document = await readYaml(path);
    const updated = await this.options.patch(document, context);
    return yaml.dump(updated, { lineWidth: -1 });
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
