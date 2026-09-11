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

import { recordConnectionFromAuth } from '@/core/auth/auth-connection-recorder.ts';
import { getToken } from '@/core/host/keychain.ts';
import { okAsync, ResultAsync } from '@/core/result.ts';
import type { Console } from '@/core/ui/console.ts';

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

export type ResolvedAuthSource = 'env' | 'state';

export type ResolvedAuthInit = {
  token: string;
  serverUrl: string;
  orgKey?: string;
  connectionType: 'cloud' | 'on-premise';
  source: ResolvedAuthSource;
};

export class ResolvedAuth {
  readonly token: string;
  readonly serverUrl: string;
  readonly orgKey?: string;
  readonly connectionType: 'cloud' | 'on-premise';
  readonly source: ResolvedAuthSource;

  constructor(init: ResolvedAuthInit) {
    this.token = init.token;
    this.serverUrl = init.serverUrl;
    this.orgKey = init.orgKey;
    this.connectionType = init.connectionType;
    this.source = init.source;
  }

  comesFromEnv(): boolean {
    return this.source === 'env';
  }
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
  /** Used for the partial-env warning when `silent` is not set. */
  console?: Console;
}

/** Memoizing auth resolver shared by the command tree and invocation contexts. */
export class AuthResolver {
  private memo?: ResultAsync<ResolvedAuth | null, Error>;

  constructor(private readonly defaults: ResolveAuthOptions = {}) {}

  resolveAuth(
    options?: Pick<ResolveAuthOptions, 'silent'>,
  ): ResultAsync<ResolvedAuth | null, Error> {
    this.memo ??= ResultAsync.fromPromise(
      this.resolveOnce({ ...this.defaults, ...options }),
      (error) => (error instanceof Error ? error : new Error(String(error))),
    );
    return this.memo;
  }

  private async resolveOnce(options: ResolveAuthOptions): Promise<ResolvedAuth | null> {
    const envAuth = this.resolveFromEnv(options);
    if (envAuth) {
      await recordConnectionFromAuth(envAuth, { envOnly: true }).catch((err: unknown) => {
        logger.debug(`Failed to record env-var connection in state: ${(err as Error).message}`);
      });
      return envAuth;
    }
    return await this.resolveFromState();
  }

  private resolveFromEnv(options: ResolveAuthOptions): ResolvedAuth | null {
    const envToken = process.env[ENV_TOKEN];
    const envServer = process.env[ENV_SERVER];
    const envOrg = process.env[ENV_ORG];

    // 1. Both SONARQUBE_CLI_TOKEN + SONARQUBE_CLI_ORG present → assume SQC, but get serverUrl from env in case of SQC US
    if (envToken && envOrg) {
      logger.debug('Using environment variable authentication (SQC)');
      return new ResolvedAuth({
        token: envToken,
        serverUrl: envServer ?? SONARCLOUD_URL,
        orgKey: envOrg,
        connectionType: 'cloud',
        source: 'env',
      });
    }

    // 2. Both SONARQUBE_CLI_TOKEN + SONARQUBE_CLI_SERVER env vars present → use them immediately
    if (envToken && envServer) {
      logger.debug('Using environment variable authentication (SQS)');
      return new ResolvedAuth({
        token: envToken,
        serverUrl: envServer,
        connectionType: 'on-premise',
        source: 'env',
      });
    }

    // 3. Partial env vars → warn (unless silenced) and ignore both
    if (!options.silent) {
      if (envToken) {
        options.console?.warn(
          `${ENV_TOKEN} is set, but either ${ENV_SERVER} or ${ENV_ORG} are required for environment variable authentication. Falling back to saved credentials.`,
        );
      } else if (envServer || envOrg) {
        const setEnv = envServer ? ENV_SERVER : ENV_ORG;
        options.console?.warn(
          `${setEnv} is set, but ${ENV_TOKEN} is required for environment variable authentication. Falling back to saved credentials.`,
        );
      }
    }
    return null;
  }

  private async resolveFromState(): Promise<ResolvedAuth | null> {
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
      return new ResolvedAuth({ token, serverUrl, orgKey, connectionType, source: 'state' });
    }
    return null;
  }
}

/** No-op resolver for disabled invocation contexts (never reads env, state, or keychain). */
export class NullAuthResolver extends AuthResolver {
  override resolveAuth(): ResultAsync<ResolvedAuth | null, Error> {
    return okAsync(null);
  }
}
