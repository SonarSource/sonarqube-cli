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

/**
 * State manager for reading and writing ~/.sonar/sonarqube-cli/state.json
 */

import fs from 'node:fs';
import crypto, { randomUUID } from 'node:crypto';
import logger from './logger.js';
import {
  type AgentConfig,
  type AgentExtension,
  type HookType,
  type AuthConnection,
  type CliState,
  type CloudRegion,
  getDefaultState,
} from './state.js';
import { CLI_DIR, STATE_FILE } from './config-constants.js';
import { version as VERSION } from '../../package.json';

/**
 * Ensure state directory exists
 */
function ensureStateDir(): void {
  if (!fs.existsSync(CLI_DIR)) {
    fs.mkdirSync(CLI_DIR, { recursive: true });
  }
}

/**
 * Load state from file, or return default if not exists
 */
export function loadState(cliVersion?: string): CliState {
  ensureStateDir();

  if (!fs.existsSync(STATE_FILE)) {
    return getDefaultState(cliVersion ?? VERSION);
  }

  try {
    const content = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(content) as CliState;
    migrateState(state);
    return state;
  } catch (error) {
    logger.debug(`Failed to load state from ${STATE_FILE}: ${(error as Error).message}`);
    return getDefaultState(cliVersion ?? VERSION);
  }
}

function migrateState(state: CliState) {
  // users might have a state file without telemetry
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!state.telemetry) {
    state.telemetry = {
      enabled: true,
      installationId: randomUUID(),
      firstUseDate: new Date().toISOString(),
      events: [],
    };
  }
  // users might have a state file without agentExtensions (pre-registry format)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!state.agentExtensions) {
    state.agentExtensions = [];
  }
}

/**
 * Save state to file
 */
export function saveState(state: CliState): void {
  ensureStateDir();

  state.lastUpdated = new Date().toISOString();

  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    throw new Error(`Failed to save state to ${STATE_FILE}: ${String(error)}`);
  }
}

/**
 * Generate connection ID from serverUrl and optional orgKey
 */
export function generateConnectionId(serverUrl: string, orgKey?: string): string {
  const input = orgKey ? `${serverUrl}:${orgKey}` : serverUrl;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Add or update authentication connection
 * Note: Currently supports only one connection. Logging in to a different server
 * will replace the previous connection.
 */
export function addOrUpdateConnection(
  state: CliState,
  serverUrl: string,
  type: 'cloud' | 'on-premise',
  options: {
    orgKey?: string;
    region?: CloudRegion;
    keystoreKey: string;
  },
): AuthConnection {
  const connectionId = generateConnectionId(serverUrl, options.orgKey);

  const connection: AuthConnection = {
    id: connectionId,
    type,
    serverUrl,
    authenticatedAt: new Date().toISOString(),
    keystoreKey: options.keystoreKey,
  };

  if (options.orgKey) {
    connection.orgKey = options.orgKey;
  }

  if (options.region) {
    connection.region = options.region;
  }

  // Support only one connection - clear all previous and add new one
  state.auth.connections = [connection];

  // Set as active
  state.auth.activeConnectionId = connectionId;
  state.auth.isAuthenticated = true;

  return connection;
}

/**
 * Get active connection
 */
export function getActiveConnection(state: CliState): AuthConnection | undefined {
  if (!state.auth.activeConnectionId) {
    return undefined;
  }

  return state.auth.connections.find((c) => c.id === state.auth.activeConnectionId);
}

/**
 * Mark agent as configured
 */
export function markAgentConfigured(state: CliState, agentName: string, cliVersion: string): void {
  if (!(state.agents[agentName] as AgentConfig | undefined)) {
    state.agents[agentName] = {
      configured: false,
      hooks: { installed: [] },
      skills: { installed: [] },
    };
  }

  state.agents[agentName].configured = true;
  state.agents[agentName].configuredAt = new Date().toISOString();
  state.agents[agentName].configuredByCliVersion = cliVersion;
}

/**
 * Add installed hook for agent (legacy — kept for backward compatibility)
 */
export function addInstalledHook(
  state: CliState,
  agentName: string,
  hookName: string,
  hookType: HookType,
): void {
  if (!Object.hasOwn(state.agents, agentName)) {
    state.agents[agentName] = {
      configured: false,
      hooks: { installed: [] },
      skills: { installed: [] },
    };
  }

  // Remove duplicate if exists (match by both name and type)
  state.agents[agentName].hooks.installed = state.agents[agentName].hooks.installed.filter(
    (h) => !(h.name === hookName && h.type === hookType),
  );

  state.agents[agentName].hooks.installed.push({
    name: hookName,
    type: hookType,
    installedAt: new Date().toISOString(),
  });
}

/**
 * Upsert an agent extension in the registry.
 * Matches by agentId + projectRoot + global + kind + name + (hookType for hooks).
 */
export function upsertAgentExtension(state: CliState, extension: AgentExtension): void {
  const idx = state.agentExtensions.findIndex((e) => {
    if (e.agentId !== extension.agentId) return false;
    if (e.projectRoot !== extension.projectRoot) return false;
    if (e.global !== extension.global) return false;
    if (e.kind !== extension.kind) return false;
    if (e.name !== extension.name) return false;
    if (e.kind === 'hook' && extension.kind === 'hook') {
      return e.hookType === extension.hookType;
    }
    return true;
  });

  if (idx >= 0) {
    state.agentExtensions[idx] = extension;
  } else {
    state.agentExtensions.push(extension);
  }
}

/**
 * Find all extensions registered for a specific agent + project root combination.
 */
export function findExtensionsByProject(
  state: CliState,
  agentId: string,
  projectRoot: string,
): AgentExtension[] {
  return state.agentExtensions.filter(
    (e) => e.agentId === agentId && e.projectRoot === projectRoot,
  );
}
