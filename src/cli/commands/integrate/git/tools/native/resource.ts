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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveGitHooksDir } from '../../../../_common/git-repo';
import type { ResourceDeclaration } from '../../../_common/registry/resources';
import type { AppliedResource, IntegrationContext } from '../../../_common/registry/types';
import type { GitHookType } from '../../options';
import { writeManagedGitHook } from './hooks';
import { getHookScript, type HookScriptOptions } from './shell-fragments';

interface NativeGitHookResourceOptions {
  id: string;
  displayName: string;
  hook: GitHookType;
}

export function nativeGitHookResource(options: NativeGitHookResourceOptions): ResourceDeclaration {
  return new NativeGitHookResource(options);
}

class NativeGitHookResource implements ResourceDeclaration {
  readonly id: string;
  readonly displayName?: string;
  readonly resourceType = 'git-hook-file';

  constructor(private readonly options: NativeGitHookResourceOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
  }

  async apply(context: IntegrationContext): Promise<AppliedResource> {
    const path = await resolveNativeGitHookPath(context, this.options.hook);
    const scriptOptions = hookScriptOptionsFromAttrs(context);
    await writeManagedGitHook(path, this.options.hook, context.force === true, scriptOptions);
    return { id: this.id, resourceType: this.resourceType, path };
  }

  async isApplied(context: IntegrationContext): Promise<boolean> {
    const path = await resolveNativeGitHookPath(context, this.options.hook);
    try {
      const existing = await readFile(path, 'utf-8');
      const expected = getHookScript(this.options.hook, hookScriptOptionsFromAttrs(context));
      return normalizeLineEndings(existing) === normalizeLineEndings(expected);
    } catch {
      return false;
    }
  }
}

function hookScriptOptionsFromAttrs(context: IntegrationContext): HookScriptOptions {
  const value = context.attrs?.dependencyRisksProject;
  return typeof value === 'string' && value.length > 0 ? { dependencyRisksProject: value } : {};
}

function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n');
}

async function resolveNativeGitHookPath(
  context: IntegrationContext,
  hook: GitHookType,
): Promise<string> {
  if (context.scope === 'global') {
    return join(context.targetRoot, hook);
  }
  return join(await resolveGitHooksDir(context.targetRoot), hook);
}
