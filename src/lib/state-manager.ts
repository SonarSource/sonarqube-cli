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
import crypto from 'node:crypto';
import logger from './logger.js';
import { CliState, getDefaultState, AuthConnection, CloudRegion } from './state.js';
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
    return JSON.parse(content) as CliState;
  } catch (error) {
    logger.debug(`Failed to load state from ${STATE_FILE}: ${(error as Error).message}`);
    return getDefaultState(cliVersion ?? VERSION);
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
    throw new Error(`Failed to save state to ${STATE_FILE}: ${error}`);
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
  }
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
 * Find connection by serverUrl and optional orgKey
 */
export function findConnection(
  state: CliState,
  serverUrl: string,
  orgKey?: string
): AuthConnection | undefined {
  const connectionId = generateConnectionId(serverUrl, orgKey);
  return state.auth.connections.find((c) => c.id === connectionId);
}

/**
 * Mark agent as configured
 */
export function markAgentConfigured(
  state: CliState,
  agentName: string,
  cliVersion: string
): void {
  if (!state.agents[agentName]) {
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
 * Add installed hook for agent
 */
export function addInstalledHook(
  state: CliState,
  agentName: string,
  hookName: string,
  hookType: 'PreToolUse' | 'PostToolUse' | 'SessionStart'
): void {
  if (!state.agents[agentName]) {
    state.agents[agentName] = {
      configured: false,
      hooks: { installed: [] },
      skills: { installed: [] },
    };
  }

  // Remove duplicate if exists
  state.agents[agentName].hooks.installed = state.agents[agentName].hooks.installed.filter(
    (h) => h.name !== hookName
  );

  state.agents[agentName].hooks.installed.push({
    name: hookName,
    type: hookType,
    installedAt: new Date().toISOString(),
  });
}

/**
 * Add installed skill for agent
 */
export function addInstalledSkill(
  state: CliState,
  agentName: string,
  skillName: string
): void {
  if (!state.agents[agentName]) {
    state.agents[agentName] = {
      configured: false,
      hooks: { installed: [] },
      skills: { installed: [] },
    };
  }

  // Remove duplicate if exists
  state.agents[agentName].skills.installed = state.agents[agentName].skills.installed.filter(
    (s) => s.name !== skillName
  );

  state.agents[agentName].skills.installed.push({
    name: skillName,
    installedAt: new Date().toISOString(),
  });
}

/**
 * Get state file path (for testing/debugging)
 */
export function getStateFilePath(): string {
  return STATE_FILE;
}
