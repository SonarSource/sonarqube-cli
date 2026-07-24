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

import logger from '@/core/observability/logger.ts';
import { warn } from '@/core/ui';

import { version as VERSION } from '../../../package.json';
import { pathComparisonKey } from '../io/fs-utils.ts';
import { loadState, saveState } from './state-repository.ts';

export { loadState, saveState };
export { tryLoadState } from './state-repository.ts';

import { type AuthConnection, type CliState, type CloudRegion } from './state.ts';

/**
 * Get the currently active authentication connection, or undefined if none.
 */
export function getActiveConnection(state: CliState): AuthConnection | undefined {
  if (!state.auth.activeConnectionId) {
    return undefined;
  }
  return state.auth.connections.find((c) => c.id === state.auth.activeConnectionId);
}

export function canonicalProjectRoot(projectRoot: string): string {
  return pathComparisonKey(projectRoot);
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
