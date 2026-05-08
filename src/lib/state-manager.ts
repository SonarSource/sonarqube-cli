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

/**
 * Business logic for manipulating in-memory state.
 * File I/O (loadState, saveState) lives in ./repository/state-repository.ts.
 */

import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export { loadState, saveState } from './repository/state-repository.js';

import {
  type AgentExtension,
  agentExtensionEquals,
  type AuthConnection,
  type CliState,
  type CloudRegion,
  type HookType,
} from './state.js';

/**
 * Get the currently active authentication connection, or undefined if none.
 */
export function getActiveConnection(state: CliState): AuthConnection | undefined {
  if (!state.auth.activeConnectionId) {
    return undefined;
  }
  return state.auth.connections.find((c) => c.id === state.auth.activeConnectionId);
}

function canonicalProjectRoot(projectRoot: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(projectRoot);
  } catch {
    canonical = resolve(projectRoot);
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/**
 * Find all extensions registered for a specific agent + project root combination.
 */
export function findExtensionsByProject(
  state: CliState,
  agentId: string,
  projectRoot: string,
): AgentExtension[] {
  const target = canonicalProjectRoot(projectRoot);
  return state.agentExtensions.filter(
    (e) => e.agentId === agentId && canonicalProjectRoot(e.projectRoot) === target,
  );
}

/**
 * Generate connection ID from serverUrl and optional orgKey
 */
export function generateConnectionId(serverUrl: string, orgKey?: string): string {
  const input = orgKey ? `${serverUrl}:${orgKey}` : serverUrl;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Add or update authentication connection.
 * Note: Currently supports only one connection. Logging in to a different server
 * will replace the previous connection.
 */
export function addOrUpdateConnection(
  state: CliState,
  serverUrl: string,
  type: 'cloud' | 'on-premise',
  options?: {
    orgKey?: string;
    region?: CloudRegion;
    tokenName?: string;
  },
): AuthConnection {
  const connectionId = generateConnectionId(serverUrl, options?.orgKey);

  const connection: AuthConnection = {
    id: connectionId,
    type,
    serverUrl,
    authenticatedAt: new Date().toISOString(),
  };

  if (options?.orgKey) {
    connection.orgKey = options.orgKey;
  }

  if (options?.region) {
    connection.region = options.region;
  }

  if (options?.tokenName) {
    connection.tokenName = options.tokenName;
  }

  // Support only one connection - clear all previous and add new one
  state.auth.connections = [connection];

  // Set as active
  state.auth.activeConnectionId = connectionId;
  state.auth.isAuthenticated = true;

  return connection;
}

/**
 * Remove a specific connection from state.
 * Clears activeConnectionId and sets isAuthenticated = false when the removed
 * connection was the active one.
 */
export function removeConnection(state: CliState, connectionId: string): void {
  state.auth.connections = state.auth.connections.filter((c) => c.id !== connectionId);
  if (state.auth.activeConnectionId === connectionId) {
    state.auth.activeConnectionId = undefined;
    state.auth.isAuthenticated = false;
  }
}

/**
 * Remove all connections from state (used by purge).
 */
export function clearAllConnections(state: CliState): void {
  state.auth.connections = [];
  state.auth.activeConnectionId = undefined;
  state.auth.isAuthenticated = false;
}

/**
 * Mark agent as configured
 */
export function markAgentConfigured(state: CliState, agentName: string, cliVersion: string): void {
  if (!Object.hasOwn(state.agents, agentName)) {
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
 * Add installed hook for agent (legacy — kept for migration compatibility)
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
 * Matches by agentId + projectRoot + kind + name + (hookType for hooks).
 * For global installs, projectRoot is set to homedir() so it naturally differs from project-level.
 */
export function upsertAgentExtension(state: CliState, extension: AgentExtension): void {
  const idx = state.agentExtensions.findIndex((e) => agentExtensionEquals(e, extension));

  if (idx >= 0) {
    // Preserve the original id — callers pass randomUUID() on every call
    state.agentExtensions[idx] = { ...extension, id: state.agentExtensions[idx].id };
  } else {
    state.agentExtensions.push(extension);
  }
}
