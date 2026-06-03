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

import type { AppliedResource, IntegrationContext } from '../types';
import {
  type BaseResourceOptions,
  type PathResolver,
  readTextFile,
  resolvePath,
  type ResourceDeclaration,
  writeFileIfChanged,
} from './common';

export interface TextSnippetResourceOptions extends BaseResourceOptions {
  targetPath: PathResolver;
  content: string | ((context: IntegrationContext) => string);
  executable?: boolean;
  startMarker: string;
  endMarker?: string;
  legacyStartMarkers?: string[];
}

export function textSnippet(options: TextSnippetResourceOptions): ResourceDeclaration {
  return new TextSnippet(options);
}

export class TextSnippet implements ResourceDeclaration {
  readonly id: string;
  readonly displayName?: string;
  readonly resourceType = 'text-snippet';
  readonly version?: string;

  constructor(private readonly options: TextSnippetResourceOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.version = options.version;
  }

  async apply(context: IntegrationContext): Promise<AppliedResource> {
    const path = await resolvePath(context, this.options.targetPath);
    await writeFileIfChanged(
      path,
      await this.renderContent(path, context),
      this.options.executable,
    );
    return { id: this.id, resourceType: this.resourceType, version: this.version, path };
  }

  async isApplied(context: IntegrationContext): Promise<boolean> {
    const path = await resolvePath(context, this.options.targetPath);
    const existing = await readTextFile(path);
    if (existing === undefined) {
      return false;
    }
    return existing.includes(this.renderManagedBlock(context));
  }

  private async renderContent(path: string, context: IntegrationContext): Promise<string> {
    const existing = (await readTextFile(path)) ?? '';
    const managedBlock = this.renderManagedBlock(context);
    const startIndex = findFirstIndex(existing, [
      this.startMarker,
      ...(this.options.legacyStartMarkers ?? []),
    ]);

    if (startIndex < 0) {
      return appendBlock(existing, managedBlock);
    }

    const endIndex = existing.indexOf(this.endMarker, startIndex);
    if (endIndex >= 0) {
      const blockEnd = endIndex + this.endMarker.length;
      return `${existing.slice(0, startIndex)}${managedBlock}${existing.slice(blockEnd)}`;
    }

    return `${existing.slice(0, startIndex)}${managedBlock}\n`;
  }

  private renderManagedBlock(context: IntegrationContext): string {
    const content =
      typeof this.options.content === 'function'
        ? this.options.content(context)
        : this.options.content;
    return `${this.startMarker}\n${content.trimEnd()}\n${this.endMarker}`;
  }

  private get startMarker(): string {
    return this.options.startMarker;
  }

  private get endMarker(): string {
    return this.options.endMarker ?? `# sonar:end ${this.id}`;
  }
}

function appendBlock(existing: string, block: string): string {
  if (existing.length === 0) {
    return `${block}\n`;
  }
  return `${existing.trimEnd()}\n\n${block}\n`;
}

function findFirstIndex(haystack: string, needles: string[]): number {
  for (const needle of needles) {
    const index = haystack.indexOf(needle);
    if (index >= 0) {
      return index;
    }
  }
  return -1;
}
