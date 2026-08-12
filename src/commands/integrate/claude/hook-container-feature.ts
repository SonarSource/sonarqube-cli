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

import {
  install,
  type InstallDecision,
  jsonPatch,
  skip,
  uninstall,
  wholeFile,
} from '@/core/framework/features';
import { normalizeDecision } from '@/core/framework/features/selection.ts';
import type {
  FeatureContainer,
  FeaturePreview,
  FeatureScope,
  FeatureTargetRoot,
  IntegrationContext,
  IntegrationInvocation,
  SubfeatureDeclaration,
} from '@/core/framework/features/types.ts';
import { isContainerIntegrationContext } from '@/core/framework/features/types.ts';
import type {
  RemovableResource,
  ResourceDeclaration,
  ResourceIdentity,
  WholeFileContent,
} from '@/core/framework/resources';

import {
  createAgentHookEntry,
  removeAgentHooks,
  resolveAgentHookScriptPath,
  upsertAgentHooks,
} from '../_common/hooks.ts';

export interface ClaudeHookSubfeature<
  TOptions = Record<string, unknown>,
> extends SubfeatureDeclaration<TOptions> {
  matcher: string;
}

export interface ClaudeHookEventContainerConfig<TOptions = Record<string, unknown>> {
  id: string;
  displayName: string;
  benefitDescription?: string;
  previewDescription?: FeaturePreview;
  event: 'PostToolUse';
  configDir: string;
  marker: string;
  scriptPath: string;
  scriptDisplayName: string;
  scriptContent: WholeFileContent;
  settingsPath: (context: IntegrationContext) => string;
  subfeatures: ClaudeHookSubfeature<TOptions>[];
  defaultInstallSubfeatureIds: string[];
  targetRoot?: FeatureTargetRoot<TOptions>;
  scope?: FeatureScope<TOptions>;
  legacyCleanups?: (ResourceIdentity & RemovableResource)[];
}

async function resolveContainerInstallDecision<TOptions>(
  subfeatures: SubfeatureDeclaration<TOptions>[],
  invocation: IntegrationInvocation<TOptions>,
): Promise<InstallDecision> {
  let uninstallCount = 0;
  for (const subfeature of subfeatures) {
    const decision = normalizeDecision(await subfeature.shouldInstall?.(invocation));
    if (decision.action === 'install' || decision.action === 'ask') {
      return install();
    }
    if (decision.action === 'uninstall') {
      uninstallCount += 1;
    }
  }
  return subfeatures.length > 0 && uninstallCount === subfeatures.length ? uninstall() : skip();
}

export function createClaudeHookEventContainer<TOptions = Record<string, unknown>>(
  config: ClaudeHookEventContainerConfig<TOptions>,
): FeatureContainer<TOptions> {
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
          config.event,
          matcher,
          config.marker,
          config.scriptPath,
        ),
      ]);
    },
    removePatch: (document) => removeAgentHooks(document, [config.marker]),
  });

  return {
    id: config.id,
    displayName: config.displayName,
    benefitDescription: config.benefitDescription,
    previewDescription: config.previewDescription,
    shouldInstall: (invocation) => resolveContainerInstallDecision(config.subfeatures, invocation),
    targetRoot: config.targetRoot,
    scope: config.scope,
    resources: [scriptResource, settingsResource],
    subfeatures: config.subfeatures.map(({ matcher: _matcher, ...subfeature }) => subfeature),
    defaultInstallSubfeatureIds: config.defaultInstallSubfeatureIds,
    legacyCleanups: config.legacyCleanups,
  };
}
