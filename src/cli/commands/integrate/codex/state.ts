/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { version as VERSION } from '../../../../../package.json';
import { isSonarQubeCloud } from '../../../../lib/auth-resolver';
import { cleanObsoleteFromState, OBSOLETE_A3S_MARKER } from '../../../../lib/migration';
import logger from '../../../../lib/logger';
import {
  addInstalledHook,
  addOrUpdateConnection,
  generateConnectionId,
  loadState,
  markAgentConfigured,
  saveState,
  upsertAgentExtension,
} from '../../../../lib/state-manager';
import { warn } from '../../../../ui';
import type { ConfigurationData } from '../_common/integrate-configuration';

/**
 * Update state after successful Codex integration (MCP + optional secrets hooks + optional SQAA).
 */
export function updateStateAfterCodexConfiguration(
  config: ConfigurationData,
  projectRoot: string,
  isGlobal: boolean,
  secretsHooksInstalled: boolean,
  sqaaHookInstalled: boolean,
): void {
  try {
    const state = loadState();
    cleanObsoleteFromState(state, OBSOLETE_A3S_MARKER);
    markAgentConfigured(state, 'codex', VERSION);

    if (secretsHooksInstalled) {
      addInstalledHook(state, 'codex', 'sonar-secrets', 'PreToolUse');
      addInstalledHook(state, 'codex', 'sonar-secrets', 'UserPromptSubmit');

      const now = new Date().toISOString();
      const effectiveRoot = isGlobal ? homedir() : projectRoot;
      const baseExt = {
        agentId: 'codex',
        projectRoot: effectiveRoot,
        global: isGlobal,
        projectKey: config.projectKey,
        orgKey: config.organization,
        serverUrl: config.serverURL,
        updatedByCliVersion: VERSION,
        updatedAt: now,
      };

      upsertAgentExtension(state, {
        ...baseExt,
        id: randomUUID(),
        kind: 'hook',
        name: 'sonar-secrets',
        hookType: 'PreToolUse',
      });
      upsertAgentExtension(state, {
        ...baseExt,
        id: randomUUID(),
        kind: 'hook',
        name: 'sonar-secrets',
        hookType: 'UserPromptSubmit',
      });
    }

    if (sqaaHookInstalled) {
      upsertAgentExtension(state, {
        agentId: 'codex',
        projectRoot,
        global: false,
        projectKey: config.projectKey,
        orgKey: config.organization,
        serverUrl: config.serverURL,
        updatedByCliVersion: VERSION,
        updatedAt: new Date().toISOString(),
        id: randomUUID(),
        kind: 'hook',
        name: 'sonar-sqaa',
        hookType: 'PostToolUse',
      });
    }

    const isCloud = isSonarQubeCloud(config.serverURL);
    const keystoreKey = generateConnectionId(config.serverURL, config.organization);
    addOrUpdateConnection(state, config.serverURL, isCloud ? 'cloud' : 'on-premise', {
      orgKey: config.organization,
      keystoreKey,
    });

    saveState(state);
  } catch (err) {
    warn(`Failed to update configuration state: ${(err as Error).message}`);
    logger.warn(`Failed to update configuration state: ${(err as Error).message}`);
  }
}
