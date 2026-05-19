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
 * Business logic and service helpers for manipulating state.
 * Low-level state.json I/O lives in ./repository/state-repository.ts.
 */

import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { version as VERSION } from '../../package.json';
import { warn } from '../ui';
import logger from './logger';
import { loadState, saveState } from './repository/state-repository.js';

export { loadState, saveState };

import {
  type AgentExtension,
  agentExtensionEquals,
  type AuthConnection,
  type CliState,
  type CloudRegion,
  type HookType,
  type SkillExtension,
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

/**
 * Record an installed binary in state.json under `tools.installed[]`. Failures
 * are logged but do not propagate — state writes must not fail an install.
 */
export function recordInstallationInState(name: string, version: string, path: string): void {
  try {
    const state = loadState();
    state.tools ??= { installed: [] };
    state.tools.installed = state.tools.installed.filter((t) => t.name !== name);
    state.tools.installed.push({
      name,
      version,
      path,
      installedAt: new Date().toISOString(),
      installedByCliVersion: VERSION,
    });
    saveState(state);
  } catch (err) {
    warn(`Failed to update state: ${(err as Error).message}`);
    logger.warn(`Failed to update state: ${(err as Error).message}`);
  }
}

type SkillExtensionStateInput = Omit<SkillExtension, 'id' | 'kind' | 'updatedAt'> & {
  updatedAt?: string;
};

/**
 * Persist a skill extension entry in the registry. Failures are logged but do
 * not propagate because extension state writes must not fail integration setup.
 */
export function recordSkillExtensionInState(extension: SkillExtensionStateInput): void {
  try {
    const { updatedAt = new Date().toISOString(), ...rest } = extension;
    const state = loadState();
    upsertAgentExtension(state, {
      id: crypto.randomUUID(),
      kind: 'skill',
      updatedAt,
      ...rest,
    });
    saveState(state);
  } catch (err) {
    warn(`Failed to record ${extension.name} skill in state: ${(err as Error).message}`);
    logger.warn(`Failed to record ${extension.name} skill in state: ${(err as Error).message}`);
  }
}
