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

import { type AgentExtension, recordAgentExtensions, withAgentState } from '../_common/state';

const COPILOT_AGENT_ID = 'copilot-cli';

export interface UpdateCopilotStateOptions {
  /**
   * When true, the sonar-secrets hook script was written in this run and a
   * matching registry entry should be recorded. False when the project-level
   * write was skipped because a healthy global install already owns that scope,
   * so state doesn't claim an install we didn't do.
   */
  hookInstalled?: boolean;
  /**
   * When true, the prompt-secrets instructions section was written and a
   * matching registry entry should be recorded.
   */
  promptSecretsInstructionsInstalled?: boolean;
  /**
   * When true, the SQAA instructions section was written and a matching
   * registry entry should be recorded. SQAA is always project-scoped even when
   * the integration was invoked with --global.
   */
  sqaaInstructionsInstalled?: boolean;
  /** Cloud project key associated with the SQAA section, if installed. */
  projectKey?: string;
  /** Cloud organization key associated with the SQAA section, if installed. */
  orgKey?: string;
  /** Server URL associated with the SQAA section, if installed. */
  serverUrl?: string;
}

/**
 * Persist the Copilot integration in the CLI state file.
 */
export async function updateCopilotState(
  projectRoot: string,
  isGlobal: boolean,
  options: UpdateCopilotStateOptions = {},
): Promise<void> {
  const {
    hookInstalled = false,
    promptSecretsInstructionsInstalled = false,
    sqaaInstructionsInstalled = false,
    projectKey,
    orgKey,
    serverUrl,
  } = options;
  await withAgentState(COPILOT_AGENT_ID, (state) => {
    const extensions: AgentExtension[] = [];
    if (hookInstalled) {
      extensions.push({ kind: 'hook', name: 'sonar-secrets', hookType: 'PreToolUse' });
    }
    if (promptSecretsInstructionsInstalled) {
      extensions.push({ kind: 'instructions', name: 'sonar-prompt-secrets' });
    }
    if (sqaaInstructionsInstalled) {
      // SQAA is always project-scoped, even on a global Copilot install.
      extensions.push({
        kind: 'instructions',
        name: 'sonar-sqaa',
        projectRoot,
        global: false,
        attrs: { projectKey, orgKey, serverUrl },
      });
    }
    recordAgentExtensions(state, COPILOT_AGENT_ID, projectRoot, isGlobal, extensions);
  });
}
