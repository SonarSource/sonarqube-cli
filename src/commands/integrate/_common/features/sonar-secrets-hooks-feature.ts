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

import { join } from 'node:path';

import type { IntegrationContext } from '@/core/framework/features/types.ts';
import {
  jsonPatch,
  type PlatformSpecificContent,
  type ResourceDeclaration,
  wholeFile,
} from '@/core/framework/resources';

import {
  createAgentHookEntry,
  removeAgentHooks,
  resolveAgentHookScriptPath,
  upsertAgentHooks,
} from '../hooks.ts';

export interface SonarSecretsHookScriptSpec {
  id: string;
  displayName: string;
  scriptPath: string;
  content: PlatformSpecificContent;
}

export interface SonarSecretsHookEntrySpec {
  eventType: string;
  /** Event matcher (e.g. tool name or `*`). Used by the default Claude/Codex writer; ignored by writers whose schema has no matcher (e.g. Cursor). */
  matcher?: string;
  marker: string;
  scriptPath: string;
}

/**
 * Serializes hook entries into an agent's hook-config document. Claude and Codex share the default
 * writer (`{ hooks: { <event>: [{ matcher, hooks: [...] }] } }`); agents whose config uses a
 * different schema (e.g. Cursor's flat `{ command }` entries) inject their own.
 */
export interface SonarSecretsHooksWriter {
  defaultValue: unknown;
  patch: (
    document: unknown,
    context: IntegrationContext,
    entries: SonarSecretsHookEntrySpec[],
    configDir: string,
  ) => unknown;
  removePatch: (document: unknown, markers: string[]) => unknown;
}

/**
 * Default writer: the nested `{ matcher, hooks: [{ type, command, timeout }] }` schema used by
 * Claude and Codex. `projectDirPlaceholder` is Claude-specific (its `${CLAUDE_PROJECT_DIR}`); pass
 * it in `SonarSecretsHooksResourcesConfig` only for Claude so Codex keeps its cwd-relative path.
 */
function createAgentHooksWriter(projectDirPlaceholder?: string): SonarSecretsHooksWriter {
  return {
    defaultValue: { hooks: {} },
    patch: (document, context, entries, configDir) =>
      upsertAgentHooks(
        document,
        entries.map((entry) =>
          createAgentHookEntry(
            context,
            configDir,
            entry.eventType,
            entry.matcher ?? '*',
            entry.marker,
            entry.scriptPath,
            { projectDirPlaceholder },
          ),
        ),
      ),
    removePatch: (document, markers) => removeAgentHooks(document, markers),
  };
}

export interface SonarSecretsHooksResourcesConfig {
  configDir: string;
  hooksConfigFileName: string;
  /** Hook scripts to install. */
  scripts: SonarSecretsHookScriptSpec[];
  hookEntries: SonarSecretsHookEntrySpec[];
  /** Hook-config serializer. Defaults to the Claude/Codex schema; agents like Cursor inject their own. */
  hookWriter?: SonarSecretsHooksWriter;
  /**
   * Agent-specific path placeholder (e.g. Claude Code's `${CLAUDE_PROJECT_DIR}`) to anchor
   * project-scope hook commands to, instead of a bare cwd-relative path. Omit for agents with no
   * such placeholder. Ignored when `hookWriter` is set.
   */
  projectDirPlaceholder?: string;
  /**
   * Re-roots the context the hook scripts, hook commands and hook config are resolved against, for
   * agents whose config directory is not `<targetRoot>/<configDir>` (e.g. Windows `%APPDATA%`).
   */
  resolveContext?: (context: IntegrationContext) => IntegrationContext;
}

export function resolveAgentHooksConfigPath(
  context: IntegrationContext,
  configDir: string,
  fileName: string,
): string {
  return join(context.targetRoot, configDir, fileName);
}

export function createSonarSecretsHooksResources(
  config: SonarSecretsHooksResourcesConfig,
): ResourceDeclaration[] {
  const writer = config.hookWriter ?? createAgentHooksWriter(config.projectDirPlaceholder);
  const rootContext = config.resolveContext ?? ((context: IntegrationContext) => context);
  const resolveHooksConfigPath = (context: IntegrationContext) =>
    resolveAgentHooksConfigPath(rootContext(context), config.configDir, config.hooksConfigFileName);

  return [
    ...config.scripts.map((script) =>
      wholeFile({
        id: script.id,
        displayName: script.displayName,
        targetPath: (context) =>
          resolveAgentHookScriptPath(rootContext(context), config.configDir, script.scriptPath),
        content: script.content,
        executable: true,
      }),
    ),
    jsonPatch({
      id: 'secrets-hooks-config',
      displayName: 'Secrets hooks configuration',
      targetPath: resolveHooksConfigPath,
      defaultValue: writer.defaultValue,
      patch: (document, context) =>
        writer.patch(document, rootContext(context), config.hookEntries, config.configDir),
      removePatch: (document) =>
        writer.removePatch(
          document,
          config.hookEntries.map((entry) => entry.marker),
        ),
    }),
  ];
}
