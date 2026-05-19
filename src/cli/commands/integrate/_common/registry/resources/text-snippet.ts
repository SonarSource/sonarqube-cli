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
  content: string;
  executable?: boolean;
  startMarker: string;
  endMarker?: string;
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
    await writeFileIfChanged(path, await this.renderContent(path), this.options.executable);
    return { id: this.id, resourceType: this.resourceType, version: this.version, path };
  }

  async isApplied(context: IntegrationContext): Promise<boolean> {
    const path = await resolvePath(context, this.options.targetPath);
    const existing = await readTextFile(path);
    if (existing === undefined) {
      return false;
    }
    return existing.includes(this.renderManagedBlock());
  }

  private async renderContent(path: string): Promise<string> {
    const existing = (await readTextFile(path)) ?? '';
    const managedBlock = this.renderManagedBlock();
    const pattern = new RegExp(
      String.raw`${escapeRegExp(this.startMarker)}[\s\S]*?${escapeRegExp(this.endMarker)}`,
    );
    if (pattern.test(existing)) {
      return existing.replace(pattern, managedBlock);
    }

    const startMarkerIndex = existing.indexOf(this.startMarker);
    if (startMarkerIndex >= 0) {
      return `${existing.slice(0, startMarkerIndex)}${managedBlock}\n`;
    }

    return appendBlock(existing, managedBlock);
  }

  private renderManagedBlock(): string {
    return `${this.startMarker}\n${this.options.content.trimEnd()}\n${this.endMarker}`;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
