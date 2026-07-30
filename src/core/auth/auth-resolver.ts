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

// Centralized auth resolver - resolves token + serverUrl from env vars, state, or keychain

import { recordConnectionFromAuth } from '@/core/host/auth-connection-recorder.ts';
import { getToken } from '@/core/host/keychain.ts';
import { warn } from '@/core/ui';

import { SONARCLOUD_URL } from '../config-constants.ts';
import logger from '../observability/logger.ts';
import { getActiveConnection } from '../state/state-manager.ts';
import { loadState } from '../state/state-repository.ts';

// Re-exported for backward compatibility (lives in server/sonarcloud-region.ts to avoid an import cycle).
export {
  cloudRegionFromUrl,
  isSonarQubeCloud,
  normalizeCloudV2Endpoint,
  resolveFromEndpoint,
} from '@/core/server/sonarcloud-region.ts';

export const ENV_TOKEN = 'SONARQUBE_CLI_TOKEN';
export const ENV_SERVER = 'SONARQUBE_CLI_SERVER';
export const ENV_ORG = 'SONARQUBE_CLI_ORG';

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
 *   1. Either SONARQUBE_CLI_TOKEN + SONARQUBE_CLI_SERVER or SONARQUBE_CLI_TOKEN + SONARQUBE_CLI_ORG  → return immediately
 *   2. Partial env vars → warn + ignore both, fall back
 *   3. Active connection from state file → server + orgKey
 *   4. Keychain lookup → token
 *   5. Throw descriptive error
 */
export interface ResolveAuthOptions {
  /** Suppress the "partial env vars" warning. */
  silent?: boolean;
}

// Env vars are fixed for the process lifetime, so this only needs to run once per process.
let envAuthRecordAttempted = false;

export async function resolveAuth(options: ResolveAuthOptions = {}): Promise<ResolvedAuth | null> {
  const envAuth = resolveFromEnv(options);
  if (envAuth) {
    await recordEnvAuthConnectionOnce(envAuth);
    return envAuth;
  }
  return await resolveFromState();
}

/**
 * Records an env-var-based auth into state.auth.connections, at most once per
 * process — env vars are fixed for the process lifetime, so repeat attempts
 * within the same run would only redo the same work.
 */
async function recordEnvAuthConnectionOnce(envAuth: ResolvedAuth): Promise<void> {
  if (envAuthRecordAttempted) {
    return;
  }
  envAuthRecordAttempted = true;
  await recordConnectionFromAuth(envAuth, { envOnly: true }).catch((err: unknown) => {
    logger.debug(`Failed to record env-var connection in state: ${(err as Error).message}`);
  });
}

/** Test-only: resets the per-process env-auth record guard between test cases. */
export function resetEnvAuthRecordGuard(): void {
  envAuthRecordAttempted = false;
}

export function resolveFromEnv(options: ResolveAuthOptions = {}): ResolvedAuth | null {
  const envToken = process.env[ENV_TOKEN];
  const envServer = process.env[ENV_SERVER];
  const envOrg = process.env[ENV_ORG];

  // 1. Both SONARQUBE_CLI_TOKEN + SONARQUBE_CLI_ORG present → assume SQC, but get serverUrl from env in case of SQC US
  if (envToken && envOrg) {
    logger.debug('Using environment variable authentication (SQC)');
    return {
      token: envToken,
      serverUrl: envServer ?? SONARCLOUD_URL,
      orgKey: envOrg,
      connectionType: 'cloud',
    };
  }

  // 2. Both SONARQUBE_CLI_TOKEN + SONARQUBE_CLI_SERVER env vars present → use them immediately
  if (envToken && envServer) {
    logger.debug('Using environment variable authentication (SQS)');
    return {
      token: envToken,
      serverUrl: envServer,
      connectionType: 'on-premise',
    };
  }

  // 3. Partial env vars → warn (unless silenced) and ignore both
  if (!options.silent) {
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
  // Let a corrupt-state read throw here so the user sees the real error
  // instead of a misleading "not authenticated".
  const state = loadState();
  const active = getActiveConnection(state);
  if (!active) {
    return null;
  }
  const connection = { serverUrl: active.serverUrl, orgKey: active.orgKey, type: active.type };

  const serverUrl = connection.serverUrl;
  if (!serverUrl) {
    return null;
  }

  const orgKey = connection.orgKey;
  const connectionType = connection.type;

  if (connectionType === 'cloud' && orgKey === undefined) {
    return null;
  }

  // Look up token in keychain
  const token = await getToken(serverUrl, orgKey);
  if (token) {
    return { token, serverUrl, orgKey, connectionType };
  }
  return null;
}
