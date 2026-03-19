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

// Centralized auth resolver - resolves token + serverUrl from env vars, state, or keychain

import { SONARCLOUD_HOSTNAME, SONARCLOUD_URL, SONARCLOUD_US_HOSTNAME } from './config-constants';
import { getToken } from './keychain.js';
import { loadState, getActiveConnection } from './state-manager.js';
import { warn } from '../ui';
import logger from './logger.js';

export const ENV_TOKEN = 'SONAR_CLI_TOKEN';
export const ENV_SERVER = 'SONAR_CLI_SERVER';
export const ENV_ORG = 'SONAR_CLI_ORG';

export interface ResolvedAuth {
  token: string;
  serverUrl: string;
  orgKey?: string;
  connectionType: 'cloud' | 'on-premise';
}

/**
 * Resolve authentication from env vars, CLI options, state file, or keychain.
 *
 * Priority:
 *   1. Either SONAR_CLI_TOKEN + SONAR_CLI_SERVER or SONAR_CLI_TOKEN + SONAR_CLI_ORG  → return immediately
 *   2. Partial env vars → warn + ignore both, fall back
 *   3. Active connection from state file → server + orgKey
 *   4. Keychain lookup → token
 *   5. Throw descriptive error
 */
export async function resolveAuth(): Promise<ResolvedAuth | null> {
  return resolveFromEnv() ?? (await resolveFromState());
}

function resolveFromEnv(): ResolvedAuth | null {
  const envToken = process.env[ENV_TOKEN];
  const envServer = process.env[ENV_SERVER];
  const envOrg = process.env[ENV_ORG];

  // 1. Both SONAR_CLI_TOKEN + SONAR_CLI_SERVER env vars present → use them immediately
  if (envToken && envServer) {
    logger.debug('Using environment variable authentication');
    return {
      token: envToken,
      serverUrl: envServer,
      connectionType: 'on-premise',
    };
  }

  // 2. Both SONAR_CLI_TOKEN + SONAR_CLI_ORG env vars present → use them immediately
  if (envToken && envOrg) {
    logger.debug('Using environment variable authentication');
    return {
      token: envToken,
      serverUrl: SONARCLOUD_URL,
      orgKey: envOrg,
      connectionType: 'cloud',
    };
  }

  // 3. Partial env vars → warn and ignore both
  if (envToken) {
    warn(
      `${ENV_TOKEN} is set, but either ${ENV_SERVER} or ${ENV_ORG} are required for environment variable authentication. Falling back to saved credentials.`,
    );
  } else if (envServer || envOrg) {
    const setEnv = envServer ? ENV_SERVER : ENV_ORG;
    warn(
      `${setEnv} is set, but ${ENV_TOKEN} is required for environment variable authentication. Falling back to saved credentials.`,
    );
  }
  return null;
}

export function isEnvBasedAuth(): boolean {
  return (
    !!(process.env[ENV_TOKEN] && process.env[ENV_SERVER]) ||
    !!(process.env[ENV_TOKEN] && process.env[ENV_ORG])
  );
}

export async function resolveFromState(): Promise<ResolvedAuth | null> {
  let connection: { serverUrl: string; orgKey?: string; type: 'cloud' | 'on-premise' };
  try {
    const state = loadState();
    const active = getActiveConnection(state);
    if (!active) {
      return null;
    }
    connection = { serverUrl: active.serverUrl, orgKey: active.orgKey, type: active.type };
  } catch (err) {
    logger.debug(`Failed to load state: ${(err as Error).message}`);
    return null;
  }

  const serverUrl = connection.serverUrl;
  if (!serverUrl) {
    return null;
  }

  const orgKey = connection.orgKey;
  const connectionType = connection.type;

  // Look up token in keychain
  const token = await getToken(serverUrl, orgKey);
  if (token) {
    return { token, serverUrl, orgKey, connectionType };
  }
  return null;
}

export function isSonarQubeCloud(serverUrl: string): boolean {
  try {
    const url = new URL(serverUrl);
    return url.hostname === SONARCLOUD_HOSTNAME || url.hostname === SONARCLOUD_US_HOSTNAME;
  } catch {
    return false;
  }
}
