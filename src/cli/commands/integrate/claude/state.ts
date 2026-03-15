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
import type { ConfigurationData } from './index';

/**
 * Update state after successful configuration
 */
export function updateStateAfterConfiguration(
  config: ConfigurationData,
  projectRoot: string,
  isGlobal: boolean,
  a3sEnabled: boolean,
): void {
  try {
    const state = loadState();

    // Mark agent as configured
    markAgentConfigured(state, 'claude-code', VERSION);

    // Track installed hooks (legacy format for backward compat)
    addInstalledHook(state, 'claude-code', 'sonar-secrets', 'PreToolUse');
    addInstalledHook(state, 'claude-code', 'sonar-secrets', 'UserPromptSubmit');

    // Register extensions in the new registry.
    // For global installs, use homedir() as projectRoot so it doesn't collide with project-level entries.
    const now = new Date().toISOString();
    const effectiveRoot = isGlobal ? homedir() : projectRoot;
    const baseExt = {
      agentId: 'claude-code',
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

    const isCloud = isSonarQubeCloud(config.serverURL);
    if (a3sEnabled) {
      upsertAgentExtension(state, {
        ...baseExt,
        projectRoot,
        global: false,
        id: randomUUID(),
        kind: 'hook',
        name: 'sonar-a3s',
        hookType: 'PostToolUse',
      });
    }

    // Save connection so `sonar auth status` reports the active connection
    const type = isCloud ? 'cloud' : 'on-premise';
    const keystoreKey = generateConnectionId(config.serverURL, config.organization);
    addOrUpdateConnection(state, config.serverURL, type, {
      orgKey: config.organization,
      keystoreKey,
    });

    saveState(state);
  } catch (err) {
    warn(`Failed to update configuration state: ${(err as Error).message}`);
    logger.warn(`Failed to update configuration state: ${(err as Error).message}`);
    // Don't fail the whole setup if state update fails
  }
}
