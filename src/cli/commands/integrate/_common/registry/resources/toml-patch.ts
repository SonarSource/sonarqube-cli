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
import type { AppliedResource, IntegrationContext, MaybePromise } from '../types';
import {
  applyPatch,
  type BaseResourceOptions,
  isPatchApplied,
  type PathResolver,
  type ResourceDeclaration,
} from './common';

export interface TomlPatchOptions extends BaseResourceOptions {
  targetPath: PathResolver;
  defaultValue?: Record<string, unknown>;
  patch: (
    document: Record<string, unknown>,
    context: IntegrationContext,
  ) => MaybePromise<Record<string, unknown>>;
}

export function tomlPatch(options: TomlPatchOptions): ResourceDeclaration {
  return new TomlPatch(options);
}

export class TomlPatch implements ResourceDeclaration {
  readonly id: string;
  readonly displayName?: string;
  readonly resourceType = 'toml-patch';
  readonly version?: string;

  constructor(private readonly options: TomlPatchOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.version = options.version;
  }

  apply(context: IntegrationContext): Promise<AppliedResource> {
    return applyPatch(this.options, this.resourceType, this.version, context, (path) =>
      this.renderContent(path, context),
    );
  }

  isApplied(context: IntegrationContext): Promise<boolean> {
    return isPatchApplied(this.options, context, (path) => this.renderContent(path, context));
  }

  private async renderContent(path: string, context: IntegrationContext): Promise<string> {
    const document = await readToml(path, this.options.defaultValue ?? {});
    const updated = await this.options.patch(document, context);
    return stringify(updated);
  }
}

async function readToml(
  path: string,
  defaultValue: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!existsSync(path)) {
    return defaultValue;
  }
  try {
    return parse(await readFile(path, 'utf-8'));
  } catch {
    throw new CommandFailedError(
      `${path} contains invalid TOML. Please fix or delete it and re-run.`,
    );
  }
}
