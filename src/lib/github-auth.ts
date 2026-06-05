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

// GitHub authentication — env var, gh CLI, keychain, then OAuth flow

import { spawnSync } from 'node:child_process';

import {
  createRequestHandler,
  openBrowserWithFallback,
  waitForTokenInteractive,
} from '../cli/commands/_common/token.js';
import { blue } from '../ui/colors.js';
import { print, warn } from '../ui/index.js';
import { deleteGitHubToken, getGitHubToken, saveGitHubToken } from './keychain.js';
import logger from './logger.js';
import { startLoopbackServer } from './loopback-server.js';
import { loadState, saveState } from './state-manager.js';

const GITHUB_OAUTH_CLIENT_ID = 'Ov23liAOQAqXSgVpvQ3V';
const GITHUB_OAUTH_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_OAUTH_SCOPES = 'read:org';

/**
 * Try to get a GitHub token from GITHUB_TOKEN env var.
 */
function resolveFromEnv(): string | null {
  return process.env.GITHUB_TOKEN ?? null;
}

/**
 * Try to get a GitHub token by shelling out to `gh auth token`.
 * Returns null if gh is not installed or not authenticated.
 */
function resolveFromGhCli(): string | null {
  try {
    const result = spawnSync('gh', ['auth', 'token'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      const token = result.stdout.trim();
      if (token.length > 0) return token;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run the GitHub OAuth loopback flow — opens a browser to GitHub's authorize
 * endpoint and captures the token via a local callback server.
 */
async function resolveViaOAuth(): Promise<string> {
  let resolveToken: ((token: string) => void) | null = null;

  const tokenPromise = new Promise<string>((resolve) => {
    resolveToken = resolve;
  });

  const server = await startLoopbackServer(
    createRequestHandler((token) => {
      resolveToken?.(token);
    }),
    { allowedOrigins: ['https://github.com'] },
  );

  const authURL =
    GITHUB_OAUTH_AUTHORIZE_URL +
    `?client_id=${GITHUB_OAUTH_CLIENT_ID}` +
    `&scope=${encodeURIComponent(GITHUB_OAUTH_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(`http://localhost:${server.port}`)}`;

  print('🔑 Connecting to GitHub…');
  print(`URL: ${blue(authURL)}`);

  let token: string;
  try {
    await openBrowserWithFallback(authURL);
    const result = await waitForTokenInteractive(tokenPromise.then((t) => ({ token: t })));
    token = result.token;
  } finally {
    await server.close().catch((err: unknown) => {
      logger.warn(`GitHub auth server shutdown error: ${(err as Error).message}`);
    });
  }

  return token;
}

/**
 * Resolve a GitHub token using the following priority:
 *   1. GITHUB_TOKEN env var
 *   2. `gh auth token` (GitHub CLI)
 *   3. Keychain (previously saved via OAuth flow)
 *   4. Browser OAuth flow → save to keychain
 *
 * Returns the token string. Throws if all methods fail.
 */
export async function resolveGitHubToken(): Promise<string> {
  const fromEnv = resolveFromEnv();
  if (fromEnv) {
    logger.debug('GitHub token resolved from GITHUB_TOKEN env var');
    return fromEnv;
  }

  const fromGh = resolveFromGhCli();
  if (fromGh) {
    logger.debug('GitHub token resolved from gh CLI');
    return fromGh;
  }

  const fromKeychain = await getGitHubToken();
  if (fromKeychain) {
    logger.debug('GitHub token resolved from keychain');
    return fromKeychain;
  }

  warn('No GitHub token found in GITHUB_TOKEN or gh CLI — starting browser OAuth flow.');
  const token = await resolveViaOAuth();

  await saveGitHubToken(token);

  const state = loadState();
  state.githubAuth = { authenticatedAt: new Date().toISOString() };
  saveState(state);

  return token;
}

export { deleteGitHubToken };
