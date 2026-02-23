// Centralized auth resolver - resolves token + serverUrl from env vars, state, or keychain

import { getToken } from './keychain.js';
import { loadState, getActiveConnection } from './state-manager.js';
import { VERSION } from '../version.js';
import { warn } from '../ui/index.js';
import logger from './logger.js';

export const ENV_TOKEN = 'SONAR_CLI_TOKEN';
export const ENV_SERVER = 'SONAR_CLI_SERVER';

export interface ResolvedAuth {
  token: string;
  serverUrl: string;
  orgKey?: string;
}

/**
 * Resolve authentication from env vars, CLI options, state file, or keychain.
 *
 * Priority:
 *   1. Both SONAR_CLI_TOKEN + SONAR_CLI_SERVER → return immediately
 *   2. Partial env vars → warn + ignore both, fall back
 *   3. options.token provided → use it with resolved server
 *   4. Active connection from state file → server + orgKey
 *   5. Keychain lookup → token
 *   6. Throw descriptive error
 */
export async function resolveAuth(options: {
  token?: string;
  server?: string;
  org?: string;
}): Promise<ResolvedAuth> {
  const envToken = process.env[ENV_TOKEN];
  const envServer = process.env[ENV_SERVER];

  // 1. Both env vars present → use them immediately
  if (envToken && envServer) {
    logger.debug('Using environment variable authentication');
    return {
      token: envToken,
      serverUrl: envServer,
      orgKey: options.org,
    };
  }

  // 2. Partial env vars → warn and ignore both
  if (envToken || envServer) {
    const missing = envToken ? ENV_SERVER : ENV_TOKEN;
    warn(
      `${missing} is not set. Both ${ENV_TOKEN} and ${ENV_SERVER} are required for environment variable authentication. Falling back to saved credentials.`
    );
  }

  // Resolve active connection from state
  let connection: { serverUrl: string; orgKey?: string } | undefined;
  try {
    const state = loadState(VERSION);
    const active = getActiveConnection(state);
    if (active) {
      connection = { serverUrl: active.serverUrl, orgKey: active.orgKey };
    }
  } catch (err) {
    logger.debug(`Failed to load state: ${(err as Error).message}`);
  }

  // Resolve serverUrl: options.server > connection.serverUrl
  const serverUrl = options.server ?? connection?.serverUrl;
  if (!serverUrl) {
    throw new Error(
      `No server URL found. Set ${ENV_TOKEN} + ${ENV_SERVER}, or run: sonar auth login`
    );
  }

  // Resolve orgKey: options.org > connection.orgKey
  const orgKey = options.org ?? connection?.orgKey;

  // 3. options.token provided → no keychain lookup needed
  if (options.token) {
    return { token: options.token, serverUrl, orgKey };
  }

  // 4 & 5. Look up token in keychain
  const token = await getToken(serverUrl, orgKey);
  if (token) {
    return { token, serverUrl, orgKey };
  }

  throw new Error(
    `No authentication token found. Set ${ENV_TOKEN} + ${ENV_SERVER}, or run: sonar auth login`
  );
}
