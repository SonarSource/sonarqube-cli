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

// Global SessionStart/SubagentStart hook that asks CAG for Vortex context at
// agent startup (CLI-986). Unlike the PostToolUse container (shared by SQAA and
// CAG), CAG is the sole subscriber of these events, so this is a plain feature
// with its own hook registration rather than a matcher-union container — see
// hook-container-feature.ts for the pattern this deliberately does not reuse.
//
// Forced to scope: 'global' regardless of the invocation's own scope/targetRoot,
// mirroring (in the opposite direction) how createVortexFeature forces
// scope: 'project' — Claude Code's SessionStart/SubagentStart hooks only make
// sense installed once, in the user's global config.

import { homedir } from 'node:os';

import type { FeatureDeclaration, IntegrationContext } from '@/core/framework/features';
import { jsonPatch, wholeFile } from '@/core/framework/features';

import { contextAugmentationBinaryDependency } from '../context-augmentation-dependency.ts';
import {
  createAgentHookEntry,
  removeAgentHooks,
  resolveAgentHookScriptPath,
  unixTemplate,
  upsertAgentHooks,
  windowsTemplate,
} from '../hooks.ts';
import type { IntegrateAgentOptions } from '../types.ts';

export const CONTEXT_AUGMENTATION_SESSION_START_FEATURE_ID =
  'context-augmentation-session-start-hook';

const SESSION_START_MARKER = 'sonar-context-session-start';

export interface ContextAugmentationSessionStartFeatureConfig<
  TOptions extends IntegrateAgentOptions,
> {
  configDir: string;
  settingsPath: (context: IntegrationContext) => string;
  sessionStartScriptPath: string;
  subagentStartScriptPath: string;
  sessionStartCommand: string;
  subagentStartCommand: string;
  shouldInstall: NonNullable<FeatureDeclaration<TOptions>['shouldInstall']>;
}

export function createContextAugmentationSessionStartFeature<
  TOptions extends IntegrateAgentOptions,
>(config: ContextAugmentationSessionStartFeatureConfig<TOptions>): FeatureDeclaration<TOptions> {
  return {
    id: CONTEXT_AUGMENTATION_SESSION_START_FEATURE_ID,
    displayName: 'Vortex context session-start hook',
    scope: 'global',
    targetRoot: () => homedir(),
    shouldInstall: config.shouldInstall,
    dependencies: [contextAugmentationBinaryDependency],
    resources: [
      wholeFile({
        id: 'context-augmentation-session-start-script',
        displayName: 'SessionStart hook script',
        targetPath: (context) =>
          resolveAgentHookScriptPath(context, config.configDir, config.sessionStartScriptPath),
        content: {
          unix: unixTemplate(config.sessionStartCommand),
          windows: windowsTemplate(config.sessionStartCommand),
        },
        executable: true,
      }),
      wholeFile({
        id: 'context-augmentation-subagent-start-script',
        displayName: 'SubagentStart hook script',
        targetPath: (context) =>
          resolveAgentHookScriptPath(context, config.configDir, config.subagentStartScriptPath),
        content: {
          unix: unixTemplate(config.subagentStartCommand),
          windows: windowsTemplate(config.subagentStartCommand),
        },
        executable: true,
      }),
      jsonPatch({
        id: 'context-augmentation-session-start-hook-config',
        displayName: 'Vortex context session-start hook configuration',
        targetPath: config.settingsPath,
        defaultValue: { hooks: {} },
        patch: (document, context) =>
          upsertAgentHooks(document, [
            createAgentHookEntry(
              context,
              config.configDir,
              'SessionStart',
              // Also resume/compact: compaction is exactly when a previously injected
              // additionalContext is dropped from the conversation, so context must be
              // re-injected there (and on resume) too, not only on a genuinely fresh start.
              'startup|clear|resume|compact',
              SESSION_START_MARKER,
              config.sessionStartScriptPath,
            ),
            createAgentHookEntry(
              context,
              config.configDir,
              'SubagentStart',
              '*',
              SESSION_START_MARKER,
              config.subagentStartScriptPath,
            ),
          ]),
        removePatch: (document) => removeAgentHooks(document, [SESSION_START_MARKER]),
      }),
    ],
  };
}
