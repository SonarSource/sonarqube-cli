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

// Shared state-mutation helpers for integrate commands.
// Centralizes the load → mark-configured → mutate → save → warn-on-failure
// pattern, and the per-extension upsert that both Claude and Copilot perform.

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import { version as VERSION } from '../../../../../package.json';
import logger from '../../../../lib/logger';
import { loadState, saveState } from '../../../../lib/repository/state-repository';
import type { BaseAgentExtension, CliState, HookType } from '../../../../lib/state';
import { markAgentConfigured, upsertAgentExtension } from '../../../../lib/state-manager';
import { warn } from '../../../../ui';

type ExtensionAttrs = Partial<Pick<BaseAgentExtension, 'projectKey' | 'orgKey' | 'serverUrl'>>;

export interface HookExtension {
  kind: 'hook';
  hookType: HookType;
  name: string;
  /** Override the projectRoot derived from (projectRoot, isGlobal). Used for SQAA, which is always project-scoped. */
  projectRoot?: string;
  /** Override the global flag for the same reason. */
  global?: boolean;
  attrs?: ExtensionAttrs;
}

export interface InstructionExtension {
  kind: 'instructions';
  name: string;
  /** Override the projectRoot derived from (projectRoot, isGlobal). Used for SQAA, which is always project-scoped. */
  projectRoot?: string;
  /** Override the global flag for the same reason. */
  global?: boolean;
  attrs?: ExtensionAttrs;
}

export type AgentExtension = HookExtension | InstructionExtension;

/**
 * Upsert a list of agent extensions in `state`. The (projectRoot, isGlobal)
 * pair sets the default scope; individual extensions may override it (SQAA is
 * always project-scoped even for a global Claude install).
 */
export function recordAgentExtensions(
  state: CliState,
  agentId: string,
  projectRoot: string,
  isGlobal: boolean,
  extensions: AgentExtension[],
): void {
  const effectiveRoot = isGlobal ? homedir() : projectRoot;
  const now = new Date().toISOString();
  for (const extension of extensions) {
    const base: BaseAgentExtension = {
      id: randomUUID(),
      agentId,
      projectRoot: extension.projectRoot ?? effectiveRoot,
      global: extension.global ?? isGlobal,
      updatedByCliVersion: VERSION,
      updatedAt: now,
      ...extension.attrs,
    };
    if (extension.kind === 'hook') {
      upsertAgentExtension(state, {
        ...base,
        kind: 'hook',
        name: extension.name,
        hookType: extension.hookType,
      });
    } else {
      upsertAgentExtension(state, {
        ...base,
        kind: 'instructions',
        name: extension.name,
      });
    }
  }
}

/**
 * Run a state mutation with the standard load/save/error envelope used by
 * every `integrate <agent>` command:
 *
 *  - load the CLI state
 *  - mark `agentId` as configured at the current CLI version
 *  - run `mutate(state)`
 *  - persist
 *  - on any failure, surface a warning to the user and log it; never throw
 *    (a state-write failure must not undo the on-disk install).
 */
export async function withAgentState(
  agentId: string,
  mutate: (state: CliState) => void | Promise<void>,
): Promise<void> {
  try {
    const state = loadState();
    markAgentConfigured(state, agentId, VERSION);
    await mutate(state);
    saveState(state);
  } catch (err) {
    const msg = (err as Error).message;
    warn(`Failed to update configuration state: ${msg}`);
    logger.warn(`Failed to update configuration state: ${msg}`);
  }
}
