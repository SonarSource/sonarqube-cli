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

import { jsonPatch, wholeFile } from '@/core/framework/features';
import type { IntegrationContext, SubfeatureDeclaration } from '@/core/framework/features/types.ts';
import { isContainerIntegrationContext } from '@/core/framework/features/types.ts';
import type { ResourceDeclaration, WholeFileContent } from '@/core/framework/resources';

import {
  createAgentHookEntry,
  removeAgentHooks,
  resolveAgentHookScriptPath,
  upsertAgentHooks,
} from '../_common/hooks.ts';
import { CLAUDE_PROJECT_DIR_PLACEHOLDER } from './hooks.ts';

export interface ClaudeHookSubfeature<
  TOptions = Record<string, unknown>,
> extends SubfeatureDeclaration<TOptions> {
  matcher: string;
}

export interface PostToolUseDispatchConfig<TOptions = Record<string, unknown>> {
  id: string;
  displayName: string;
  configDir: string;
  marker: string;
  scriptPath: string;
  scriptDisplayName: string;
  scriptContent: WholeFileContent;
  settingsPath: (context: IntegrationContext) => string;
  subfeatures: ClaudeHookSubfeature<TOptions>[];
}

/**
 * Container-level resources for a Claude `PostToolUse` hook shared by
 * multiple subfeatures: one script plus one settings.json entry whose
 * matcher is the union of whichever of `config.subfeatures` end up active.
 * Meant to be passed as `createVortexFeature`'s subfeatures' sibling
 * container resources (see `claudeVortexFeature` in `claude/declaration.ts`)
 * — the subfeatures themselves (with their own `shouldInstall`) are declared
 * alongside the other Vortex subfeatures, not nested under these resources.
 */
export function createPostToolUseDispatchResources<TOptions = Record<string, unknown>>(
  config: PostToolUseDispatchConfig<TOptions>,
): ResourceDeclaration[] {
  const matcherBySubfeatureId = new Map(config.subfeatures.map((s) => [s.id, s.matcher]));

  function resolveUnionMatcher(context: IntegrationContext): string {
    const active = isContainerIntegrationContext(context) ? context.activeSubfeatures : [];
    return active
      .map((subfeature) => matcherBySubfeatureId.get(subfeature.id))
      .filter((matcher): matcher is string => Boolean(matcher))
      .join('|');
  }

  const scriptResource: ResourceDeclaration = wholeFile({
    id: `${config.id}-script`,
    displayName: config.scriptDisplayName,
    targetPath: (context) =>
      resolveAgentHookScriptPath(context, config.configDir, config.scriptPath),
    content: config.scriptContent,
    executable: true,
  });

  const settingsResource: ResourceDeclaration = jsonPatch({
    id: `${config.id}-settings`,
    displayName: `${config.displayName} configuration`,
    targetPath: config.settingsPath,
    defaultValue: { hooks: {} },
    patch: (document, context) => {
      const matcher = resolveUnionMatcher(context);
      if (!matcher) {
        return removeAgentHooks(document, [config.marker]);
      }
      return upsertAgentHooks(document, [
        createAgentHookEntry(
          context,
          config.configDir,
          'PostToolUse',
          matcher,
          config.marker,
          config.scriptPath,
          {
            projectDirPlaceholder: CLAUDE_PROJECT_DIR_PLACEHOLDER,
          },
        ),
      ]);
    },
    removePatch: (document) => removeAgentHooks(document, [config.marker]),
  });

  return [scriptResource, settingsResource];
}
