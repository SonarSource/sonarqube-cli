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

import type { AppliedResource, IntegrationContext, MaybePromise } from '../types';
import {
  type BaseResourceOptions,
  detectEol,
  includesIgnoringEol,
  type PathResolver,
  readTextFile,
  resolvePath,
  type ResourceDeclaration,
  toEol,
  writeFileIfChanged,
} from './common';

export interface TextSnippetResourceOptions extends BaseResourceOptions {
  targetPath: PathResolver;
  content: string | ((context: IntegrationContext) => MaybePromise<string>);
  executable?: boolean;
  startMarker: string;
  endMarker?: string;
  /**
   * Managed blocks written by older versions, stripped before (re)writing or removing the current
   * block so re-running migrates an old install without leaving a duplicate. `endMarker` defaults to
   * this resource's end marker (handy when only the start marker changed across versions).
   */
  legacyBlocks?: Array<{ startMarker: string; endMarker?: string }>;
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
    const content = await this.resolveContent(context);
    await writeFileIfChanged(
      path,
      await this.renderContent(path, content),
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
    const content = await this.resolveContent(context);
    const renderedContent = this.renderManagedBlock(content, detectEol(existing));
    return includesIgnoringEol(existing, renderedContent);
  }

  async remove(context: IntegrationContext): Promise<void> {
    const path = await resolvePath(context, this.options.targetPath);
    const existing = await readTextFile(path);
    if (existing === undefined) {
      return;
    }
    const eol = detectEol(existing);
    let updated = this.stripLegacyBlocks(existing, eol);
    updated = removeManagedBlocks(updated, this.startMarker, this.endMarker, eol);
    if (updated !== existing) {
      await writeFileIfChanged(path, updated);
    }
  }

  private async resolveContent(context: IntegrationContext): Promise<string> {
    const { content } = this.options;
    return typeof content === 'function' ? content(context) : content;
  }

  private async renderContent(path: string, content: string): Promise<string> {
    const raw = (await readTextFile(path)) ?? '';
    const eol = detectEol(raw);
    const existing = this.stripLegacyBlocks(raw, eol);
    const managedBlock = this.renderManagedBlock(content, eol);

    const startIndex = existing.indexOf(this.startMarker);
    if (startIndex < 0) {
      return appendBlock(existing, managedBlock, eol);
    }

    // Replace the current block in place: from the start marker to the end marker, or to the end of
    // the file when the end marker is absent (older fragments were appended without one).
    const endIndex = existing.indexOf(this.endMarker, startIndex + this.startMarker.length);
    if (endIndex < 0) {
      return `${existing.slice(0, startIndex)}${managedBlock}${eol}`;
    }
    const blockEnd = endIndex + this.endMarker.length;
    return `${existing.slice(0, startIndex)}${managedBlock}${existing.slice(blockEnd)}`;
  }

  /** Removes any legacy managed blocks so a re-install/remove migrates old installs without duplicating. */
  private stripLegacyBlocks(existing: string, eol: string): string {
    let result = existing;
    for (const block of this.options.legacyBlocks ?? []) {
      if (block.startMarker === this.startMarker) {
        continue;
      }
      result = removeManagedBlocks(
        result,
        block.startMarker,
        block.endMarker ?? this.endMarker,
        eol,
      );
    }
    return result;
  }

  private renderManagedBlock(content: string, eol: string): string {
    const body = toEol(content.trimEnd(), eol);
    return [this.startMarker, body, this.endMarker].join(eol);
  }

  private get startMarker(): string {
    return this.options.startMarker;
  }

  private get endMarker(): string {
    return this.options.endMarker ?? `# sonar:end ${this.id}`;
  }
}

/**
 * Removes every managed block delimited by `startMarker`..`endMarker`, dropping the one adjacent line
 * ending on each side that was inserted with the block. A block whose start marker is present but
 * whose end marker is missing — older fragments were appended without one — is removed from the start
 * marker to the end of the content. Returns the content unchanged when the start marker is absent.
 */
function removeManagedBlocks(
  content: string,
  startMarker: string,
  endMarker: string,
  eol: string,
): string {
  let result = content;
  let startIndex = result.indexOf(startMarker);
  while (startIndex >= 0) {
    const endIndex = result.indexOf(endMarker, startIndex + startMarker.length);
    const blockEnd = endIndex >= 0 ? endIndex + endMarker.length : result.length;

    const before = sliceBefore(result, startIndex, eol);
    const after = sliceAfter(result, blockEnd, eol);
    result = before + after;
    startIndex = result.indexOf(startMarker);
  }
  return result;
}

/** Slices `[0, index)`, dropping one trailing `eol` if present immediately before `index`. */
function sliceBefore(content: string, index: number, eol: string): string {
  return content.slice(0, index - (content.endsWith(eol, index) ? eol.length : 0));
}

/** Slices `[index, end)`, skipping one leading `eol` if present at `index`. */
function sliceAfter(content: string, index: number, eol: string): string {
  return content.slice(index + (content.startsWith(eol, index) ? eol.length : 0));
}

function appendBlock(existing: string, block: string, eol: string): string {
  if (existing.length === 0) {
    return `${block}${eol}`;
  }
  return `${existing.trimEnd()}${eol}${eol}${block}${eol}`;
}
