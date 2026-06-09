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

import { rm } from 'node:fs/promises';

import { CommandFailedError } from '../../../../_common/error';
import type { AppliedResource, IntegrationContext, MaybePromise } from '../types';
import {
  type BaseResourceOptions,
  equalsIgnoringEol,
  type PathResolver,
  readTextFile,
  type RemovableResource,
  resolvePath,
  type ResourceDeclaration,
  type ResourceIdentity,
  writeFileIfChanged,
} from './common';

export interface PlatformSpecificContent {
  windows: string;
  unix: string;
}

export type WholeFileContent =
  | string
  | PlatformSpecificContent
  | ((context: IntegrationContext) => MaybePromise<string>);

export interface WholeFileResourceOptions extends BaseResourceOptions {
  targetPath: PathResolver;
  content: WholeFileContent;
  executable?: boolean;
  requiresForce?: boolean;
  /** Marker identifying the file as Sonar-managed (safe to overwrite without --force). */
  managedMarker?: string;
  /** Hint rendered (on a separate line) when refusing to overwrite an unmanaged file. */
  overwriteRemediationHint?: string;
}

export function wholeFile(options: WholeFileResourceOptions): ResourceDeclaration {
  return new WholeFileResource(options);
}

export class WholeFileResource implements ResourceDeclaration {
  readonly id: string;
  readonly displayName?: string;
  readonly resourceType = 'whole-file';
  readonly version?: string;

  private readonly remover: RemovableResource;

  constructor(private readonly options: WholeFileResourceOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.version = options.version;
    this.remover = new WholeFileRemover({
      id: options.id,
      version: options.version,
      targetPath: options.targetPath,
      managedMarker: options.managedMarker,
    });
  }

  async apply(context: IntegrationContext): Promise<AppliedResource> {
    const path = await resolvePath(context, this.options.targetPath);
    const content = await this.resolveContent(context);
    await this.assertOverwriteAllowed(path, content, context);
    await writeFileIfChanged(path, content, this.options.executable);
    return { id: this.id, resourceType: this.resourceType, version: this.version, path };
  }

  async isApplied(context: IntegrationContext): Promise<boolean> {
    const path = await resolvePath(context, this.options.targetPath);
    const existing = await readTextFile(path);
    return (
      existing !== undefined && equalsIgnoringEol(existing, await this.resolveContent(context))
    );
  }

  async remove(context: IntegrationContext): Promise<void> {
    await this.remover.remove(context);
  }

  private async resolveContent(context: IntegrationContext): Promise<string> {
    const { content } = this.options;
    if (typeof content === 'function') {
      return content(context);
    }
    if (typeof content === 'string') {
      return content;
    }
    return process.platform === 'win32' ? content.windows : content.unix;
  }

  private async assertOverwriteAllowed(
    path: string,
    content: string,
    context: IntegrationContext,
  ): Promise<void> {
    const existing = await readTextFile(path);
    if (
      existing === undefined ||
      equalsIgnoringEol(existing, content) ||
      this.options.requiresForce !== true ||
      context.force === true ||
      this.isManaged(existing)
    ) {
      return;
    }

    const label = this.displayName ?? this.id;
    throw new CommandFailedError(`A different ${label} already exists at ${path}.`, {
      remediationHint: this.options.overwriteRemediationHint,
    });
  }

  private isManaged(existing: string): boolean {
    const { managedMarker } = this.options;
    return managedMarker !== undefined && existing.includes(managedMarker);
  }
}

export interface WholeFileRemoverOptions {
  id: string;
  version?: string;
  targetPath: PathResolver;
  /** Marker identifying the file as Sonar-managed. Only removes the file when the marker is found. */
  managedMarker?: string;
}

export function wholeFileRemover(
  options: WholeFileRemoverOptions,
): ResourceIdentity & RemovableResource {
  return new WholeFileRemover(options);
}

class WholeFileRemover implements RemovableResource {
  readonly id: string;
  readonly version?: string;
  readonly resourceType = 'whole-file';

  constructor(private readonly options: WholeFileRemoverOptions) {
    this.id = options.id;
    this.version = options.version;
  }

  async remove(context: IntegrationContext): Promise<void> {
    const path = await resolvePath(context, this.options.targetPath);
    const existing = await readTextFile(path);
    if (existing === undefined) {
      return;
    }
    if (
      this.options.managedMarker !== undefined &&
      !existing.includes(this.options.managedMarker)
    ) {
      return;
    }
    await rm(path);
  }
}
