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

import type { IntegrationContext, SubfeatureDeclaration } from '@/core/framework/features';
import { jsonPatch, wholeFile } from '@/core/framework/features';

import {
  buildUnixHookScript,
  buildWindowsHookScript,
  createAgentHookEntry,
  removeAgentHooks,
  resolveAgentHookScriptPath,
  upsertAgentHooks,
} from '../hooks.ts';
import type { IntegrateAgentOptions } from '../types.ts';

const STOP_SCRIPT_REL = 'sonar-stop/build-scripts/stop';

interface CompletionAnalysisHookConfig {
  agent: 'claude' | 'codex';
  configDir: string;
  settingsPath: (context: IntegrationContext) => string;
}

export function createCompletionAnalysisHookSubfeature<TOptions extends IntegrateAgentOptions>({
  agent,
  configDir,
  settingsPath,
}: CompletionAnalysisHookConfig): SubfeatureDeclaration<TOptions> {
  return {
    id: 'completion-analysis-hook',
    displayName: 'Vortex completion analysis hook',
    required: true,
    resources: [
      wholeFile({
        id: 'completion-analysis-hook-script',
        displayName: 'Completion analysis hook script',
        targetPath: (context) => resolveAgentHookScriptPath(context, configDir, STOP_SCRIPT_REL),
        content: {
          unix: buildUnixHookScript(`agent-stop --agent ${agent}`),
          windows: buildWindowsHookScript(`agent-stop --agent ${agent}`),
        },
        executable: true,
      }),
      jsonPatch({
        id: 'completion-analysis-hook-config',
        displayName: 'Completion analysis hook configuration',
        targetPath: settingsPath,
        defaultValue: { hooks: {} },
        patch: (document, context) =>
          upsertAgentHooks(document, [
            createAgentHookEntry(
              context,
              configDir,
              'Stop',
              undefined,
              'sonar-stop',
              STOP_SCRIPT_REL,
            ),
          ]),
        removePatch: (document) => removeAgentHooks(document, ['sonar-stop']),
      }),
    ],
  };
}
