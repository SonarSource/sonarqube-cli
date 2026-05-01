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

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import { version as VERSION } from '../../../../../package.json';
import logger from '../../../../lib/logger';
import { loadState, saveState } from '../../../../lib/repository/state-repository';
import {
  addInstalledHook,
  markAgentConfigured,
  upsertAgentExtension,
} from '../../../../lib/state-manager';
import { warn } from '../../../../ui';

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
   * When true, the prompt-secrets instructions file was written and a matching
   * registry entry should be recorded.
   */
  instructionsInstalled?: boolean;
}

/**
 * Persist the Copilot integration in the CLI state file: mark the agent as
 * configured, register the legacy installed-hook entry, and upsert the
 * agent-extension registry entries for any artifacts that were actually
 * installed in this run.
 *
 * Failures are logged and warned but do not propagate — a state-write failure
 * does not undo the on-disk hook installation.
 */
export function updateCopilotState(
  projectRoot: string,
  isGlobal: boolean,
  { hookInstalled = false, instructionsInstalled = false }: UpdateCopilotStateOptions = {},
): void {
  try {
    const state = loadState();

    markAgentConfigured(state, COPILOT_AGENT_ID, VERSION);

    const effectiveRoot = isGlobal ? homedir() : projectRoot;
    const now = new Date().toISOString();

    if (hookInstalled) {
      addInstalledHook(state, COPILOT_AGENT_ID, 'sonar-secrets', 'PreToolUse');
      upsertAgentExtension(state, {
        id: randomUUID(),
        kind: 'hook',
        agentId: COPILOT_AGENT_ID,
        name: 'sonar-secrets',
        hookType: 'PreToolUse',
        projectRoot: effectiveRoot,
        global: isGlobal,
        updatedByCliVersion: VERSION,
        updatedAt: now,
      });
    }

    if (instructionsInstalled) {
      upsertAgentExtension(state, {
        id: randomUUID(),
        kind: 'instructions',
        agentId: COPILOT_AGENT_ID,
        name: 'sonar-prompt-secrets',
        projectRoot: effectiveRoot,
        global: isGlobal,
        updatedByCliVersion: VERSION,
        updatedAt: now,
      });
    }

    saveState(state);
  } catch (err) {
    const msg = (err as Error).message;
    warn(`Failed to update configuration state: ${msg}`);
    logger.warn(`Failed to update configuration state: ${msg}`);
  }
}
