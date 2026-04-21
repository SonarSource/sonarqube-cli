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

// Auth module - OAuth flow and token management

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as readline from 'node:readline';

import { openBrowser } from '../../../lib/browser';
import logger from '../../../lib/logger';
import { startLoopbackServer } from '../../../lib/loopback-server';
import { SonarQubeClient } from '../../../sonarqube/client';
import { isMockActive, pressEnterKeyPrompt, print, warn } from '../../../ui';
import { blue } from '../../../ui/colors';

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_METHOD_NOT_ALLOWED = 405;
const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413;
const MAX_POST_BODY_BYTES = 4096;

/**
 * Payload delivered by the SonarQube auth callback to the loopback server.
 * `name` is the server-assigned token name (e.g. "SonarQube CLI 4") and is
 * required to revoke the token later via `api/user_tokens/revoke`.
 * It is absent when a user manually pastes a token instead of completing
 * the browser flow.
 */
export interface TokenCallbackPayload {
  token: string;
  name?: string;
}

/**
 * Validate token by calling SonarQube API
 */
export async function validateToken(serverURL: string, token: string): Promise<boolean> {
  try {
    const client = new SonarQubeClient(serverURL, token);
    return await client.validateToken();
  } catch {
    return false;
  }
}

/**
 * Extract token (and optional name) from POST body JSON.
 * The SonarQube auth callback posts `{ login, name, token, createdAt }`;
 * only `token` is required, `name` is captured when present for later revocation.
 */
export function extractTokenFromPostBody(body: string): TokenCallbackPayload | undefined {
  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    const token = data.token;
    if (typeof token !== 'string' || token.length === 0) {
      return undefined;
    }
    const name = data.name;
    const payload: TokenCallbackPayload = { token };
    if (typeof name === 'string' && name.length > 0) {
      payload.name = name;
    }
    return payload;
  } catch {
    return undefined;
  }
}

/**
 * Build authentication URL from server URL and port
 */
export function buildAuthURL(serverURL: string, port: number): string {
  const cleanServerURL = serverURL.replace(/\/$/, '');
  if (serverURL.includes('sonarcloud') || serverURL.includes('sonarqube.us')) {
    return `${cleanServerURL}/auth?product=cli&port=${port}`;
  }
  // temporarily fallback to SQS and IDE auth page, should be fixed soon
  return `${cleanServerURL}/sonarlint/auth?ideName=sonarqube-cli&port=${port}`;
}

/**
 * Open browser, with fallback message if it fails.
 * Skipped when CI=true — token must be delivered directly to the loopback server.
 */
export async function openBrowserWithFallback(authURL: string): Promise<void> {
  if (process.env.CI === 'true') {
    return;
  }
  try {
    await openBrowser(authURL);
  } catch (error) {
    warn(`Failed to open browser automatically: ${String(error)}`);
    print('Copy the URL above and open it manually');
  }
}

/**
 * Send success response to HTTP client
 */
export function sendSuccessResponse(
  res: ServerResponse,
  extractedPayload?: TokenCallbackPayload,
  onToken?: (payload: TokenCallbackPayload) => void,
): void {
  res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'text/plain' });
  res.end('OK');
  if (extractedPayload && onToken) {
    onToken(extractedPayload);
  }
}

/**
 * Handle POST request - read body and extract token
 */
export function handlePostRequest(
  req: IncomingMessage,
  res: ServerResponse,
  onToken: (payload: TokenCallbackPayload) => void,
): void {
  let body = '';
  let bodySize = 0;
  req.on('data', (chunk: Buffer) => {
    bodySize += chunk.length;
    if (bodySize > MAX_POST_BODY_BYTES) {
      logger.warn(`POST body exceeds ${MAX_POST_BODY_BYTES} bytes limit, rejecting`);
      res.writeHead(HTTP_STATUS_PAYLOAD_TOO_LARGE);
      res.end('Payload Too Large');
      req.destroy();
      return;
    }
    body += chunk.toString();
  });
  req.on('end', () => {
    if (bodySize > MAX_POST_BODY_BYTES) {
      return;
    }
    const extractedPayload = extractTokenFromPostBody(body);
    sendSuccessResponse(res, extractedPayload ?? undefined, onToken);
  });
}

/**
 * Create request handler for loopback server
 */
export function createRequestHandler(onToken: (payload: TokenCallbackPayload) => void) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST') {
      handlePostRequest(req, res, onToken);
    } else {
      res.writeHead(HTTP_STATUS_METHOD_NOT_ALLOWED);
      res.end('Method Not Allowed');
    }
  };
}

/**
 * Interactive wait: resolves when the loopback server delivers the token
 * OR the user manually pastes one and presses Enter.
 * Rejects on Ctrl+C cancellation.
 * Uses readline (not TextPrompt) so that when the server delivers the token we can
 * close the interface and release stdin, avoiding the prompt staying open and
 * blocking the next prompt (e.g. org key) on Windows.
 *
 * Manual-paste submissions yield `{ token }` without a `name`; the server callback
 * path yields `{ token, name? }` as received from the SonarQube auth flow.
 */
export async function waitForTokenInteractive(
  serverTokenPromise: Promise<TokenCallbackPayload>,
): Promise<TokenCallbackPayload> {
  return new Promise<TokenCallbackPayload>((resolve, reject) => {
    let settled = false;
    /** Only call rl.close() once; skip when we're already inside the 'close' handler (e.g. Ctrl+C). */
    let rlClosed = false;

    function settle(payload?: TokenCallbackPayload, err?: Error): void {
      if (settled) return;
      settled = true;
      if (!rlClosed) {
        rlClosed = true;
        rl.close();
        process.stdin.resume(); // so next prompt (e.g. org key) receives keypresses on Windows
      }
      if (err) reject(err);
      else resolve(payload ?? { token: '' });
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.on('close', () => {
      if (!settled) settle(undefined, new Error('Authentication cancelled'));
    });

    serverTokenPromise
      .then((payload) => {
        settle(payload);
      })
      .catch(() => undefined);

    print('  ⏳  Waiting for authorization... or paste token and press Enter:');
    rl.question('', (line) => {
      if (settled) return;
      const userToken = line.trim();
      if (userToken.length > 0) settle({ token: userToken });
    });
  });
}

/**
 * Generate token via browser OAuth flow.
 * Returns `{ token, name? }`. `name` is the server-issued token name, present
 * when the callback POSTed it (modern SonarQube auth pages) and absent when the
 * user manually pasted a token.
 */
export async function generateTokenViaBrowser(
  serverURL: string,
  openBrowserFn: (url: string) => Promise<void> = openBrowserWithFallback,
): Promise<TokenCallbackPayload> {
  let resolveToken: ((payload: TokenCallbackPayload) => void) | null = null;

  const tokenPromise = new Promise<TokenCallbackPayload>((resolve) => {
    resolveToken = resolve;
  });

  // Allow the Sonar server origin so the OAuth callback POST is not blocked by DNS rebinding protection
  const serverOrigin = new URL(serverURL).origin;
  const server = await startLoopbackServer(
    createRequestHandler((payload: TokenCallbackPayload) => {
      if (resolveToken) {
        resolveToken(payload);
      }
    }),
    { allowedOrigins: [serverOrigin] },
  );

  const authURL = buildAuthURL(serverURL, server.port);

  print('🔑 Obtaining access token from SonarQube...');
  print(`URL: ${blue(authURL)}`);
  await pressEnterKeyPrompt('Press Enter to open the browser');
  await openBrowserFn(authURL);

  let payload: TokenCallbackPayload | undefined;
  try {
    if (isMockActive() || process.env.CI === 'true') {
      // Non-interactive: wait for server token
      payload = await tokenPromise;
    } else {
      // Interactive: race between browser delivery and manual paste
      payload = await waitForTokenInteractive(tokenPromise);
    }
  } finally {
    await server.close().catch((err: unknown) => {
      logger.warn(`Auth server shutdown error: ${(err as Error).message}`);
    });
  }

  return payload;
}
