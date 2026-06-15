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
import { EOL } from 'node:os';
import { dirname } from 'node:path';

import type { AppliedResource, IntegrationContext, MaybePromise } from '../types';

const EXECUTABLE_FILE_MODE = 0o755;

export type PathResolver = string | ((context: IntegrationContext) => MaybePromise<string>);

export interface BaseResourceOptions {
  id: string;
  displayName?: string;
  version?: string;
}

export interface ResourceIdentity {
  id: string;
  resourceType: string;
  version?: string;
}

export interface RemovableResource {
  remove(context: IntegrationContext): MaybePromise<void>;
}

export interface ResourceDeclaration extends ResourceIdentity, RemovableResource {
  displayName?: string;
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

/** Returns true when `a` and `b` have the same content, ignoring differences in line endings. */
export function equalsIgnoringEol(a: string, b: string): boolean {
  return toEol(a, EOL) === toEol(b, EOL);
}

export function includesIgnoringEol(content: string, substring: string): boolean {
  return toEol(content, EOL).includes(toEol(substring, EOL));
}

/** Rewrites every line ending in `value` to `eol`. */
export function toEol(value: string, eol: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\n', eol);
}

/**
 * Returns the newline sequence the content already uses (`\r\n` or `\n`), so generated text
 * can match the file's existing convention. Falls back to the OS default when both are present.
 */
export function detectEol(content: string): string {
  const containsCrlf = content.includes('\r\n');
  const containsLf = /(?<!\r)\n/.test(content);
  if (containsCrlf && containsLf) {
    return EOL;
  }
  if (containsCrlf) {
    return '\r\n';
  }
  return '\n';
}

export interface RemoveablePatchResourceOptions<TDoc = unknown> {
  id: string;
  version?: string;
  targetPath: PathResolver;
  removePatch: (document: TDoc, context: IntegrationContext) => MaybePromise<unknown>;
}

/** Base class for format-specific patch removers. Subclasses supply `readDocument` and `serializeDocument`. */
export abstract class RemoveablePatchResource<TDoc = unknown> implements RemovableResource {
  readonly id: string;
  readonly version?: string;
  abstract readonly resourceType: string;

  constructor(protected readonly options: RemoveablePatchResourceOptions<TDoc>) {
    this.id = options.id;
    this.version = options.version;
  }

  async remove(context: IntegrationContext): Promise<void> {
    const path = await resolvePath(context, this.options.targetPath);
    if (!existsSync(path)) {
      return;
    }
    const document = await this.readDocument(path);
    const updatedDocument = await this.options.removePatch(document, context);
    await writeFileIfChanged(path, this.serializeDocument(updatedDocument ?? document));
  }

  protected abstract readDocument(path: string): Promise<TDoc>;
  protected abstract serializeDocument(document: unknown): string;
}

export interface PatchResourceOptions<TDoc = unknown> extends BaseResourceOptions {
  targetPath: PathResolver;
  patch: (document: TDoc, context: IntegrationContext) => MaybePromise<unknown>;
  removePatch: (document: TDoc, context: IntegrationContext) => MaybePromise<unknown>;
}

export abstract class PatchResource<
  O extends PatchResourceOptions<TDoc>,
  TDoc = unknown,
> implements ResourceDeclaration {
  readonly id: string;
  readonly displayName?: string;
  readonly version?: string;
  abstract readonly resourceType: string;

  constructor(
    protected readonly options: O,
    private readonly remover: RemovableResource,
  ) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.version = options.version;
  }

  async apply(context: IntegrationContext): Promise<AppliedResource> {
    const path = await resolvePath(context, this.options.targetPath);
    await writeFileIfChanged(path, await this.renderContent(path, context));
    return { id: this.id, resourceType: this.resourceType, version: this.version, path };
  }

  async isApplied(context: IntegrationContext): Promise<boolean> {
    const path = await resolvePath(context, this.options.targetPath);
    return (await readTextFile(path)) === (await this.renderContent(path, context));
  }

  async remove(context: IntegrationContext): Promise<void> {
    await this.remover.remove(context);
  }

  protected async renderContent(path: string, context: IntegrationContext): Promise<string> {
    const document = await this.readDocument(path);
    const updatedDocument = await this.options.patch(document, context);
    return this.serializeDocument(updatedDocument ?? document);
  }

  protected abstract readDocument(path: string): Promise<TDoc>;
  protected abstract serializeDocument(document: unknown): string;
}
