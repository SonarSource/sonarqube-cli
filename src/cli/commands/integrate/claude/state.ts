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

import { cloudRegionFromUrl, isSonarQubeCloud } from '../../../../lib/auth-resolver';
import { deleteStaleTokens } from '../../../../lib/keychain';
import { addInstalledHook, addOrUpdateConnection } from '../../../../lib/state-manager';
import { type AgentExtension, recordAgentExtensions, withAgentState } from '../_common/state';
import type { ConfigurationData } from './index';

const CLAUDE_AGENT_ID = 'claude-code';

export interface UpdateStateOptions {
  /**
   * When true, do not register project-level sonar-secrets entries in state.
   * Use when a global sonar-secrets hook already owns that scope and the
   * project-level installation was intentionally skipped.
   */
  skipSecretsHooks?: boolean;
}

/**
 * Update state after successful configuration
 */
export async function updateStateAfterConfiguration(
  config: ConfigurationData,
  projectRoot: string,
  isGlobal: boolean,
  sqaaEnabled: boolean,
  options: UpdateStateOptions = {},
): Promise<void> {
  const { skipSecretsHooks = false } = options;

  await withAgentState(CLAUDE_AGENT_ID, async (state) => {
    // Track installed hooks (legacy format for backward compat).
    // Skip secrets entries when a pre-existing global hook owns that scope.
    if (!skipSecretsHooks) {
      addInstalledHook(state, CLAUDE_AGENT_ID, 'sonar-secrets', 'PreToolUse');
      addInstalledHook(state, CLAUDE_AGENT_ID, 'sonar-secrets', 'UserPromptSubmit');
    }
    if (sqaaEnabled) {
      addInstalledHook(state, CLAUDE_AGENT_ID, 'sonar-sqaa', 'PostToolUse');
    }

    const attrs = {
      projectKey: config.projectKey,
      orgKey: config.organization,
      serverUrl: config.serverURL,
    };

    const extensions: AgentExtension[] = [];
    if (!skipSecretsHooks) {
      extensions.push(
        { kind: 'hook', name: 'sonar-secrets', hookType: 'PreToolUse', attrs },
        { kind: 'hook', name: 'sonar-secrets', hookType: 'UserPromptSubmit', attrs },
      );
    }
    // SQAA is always project-scoped, even on a global Claude install.
    if (sqaaEnabled) {
      extensions.push({
        kind: 'hook',
        name: 'sonar-sqaa',
        hookType: 'PostToolUse',
        projectRoot,
        global: false,
        attrs,
      });
    }
    recordAgentExtensions(state, CLAUDE_AGENT_ID, projectRoot, isGlobal, extensions);

    // Save connection so `sonar auth status` reports the active connection
    const isCloud = isSonarQubeCloud(config.serverURL);
    const type = isCloud ? 'cloud' : 'on-premise';
    await deleteStaleTokens(state.auth.connections, config.serverURL, config.organization);
    addOrUpdateConnection(state, config.serverURL, type, {
      orgKey: config.organization,
      region: cloudRegionFromUrl(config.serverURL),
    });
  });
}
