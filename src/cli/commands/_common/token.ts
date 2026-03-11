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

// Auth module - OAuth flow and token management

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as readline from 'node:readline';
import {
  getToken as getKeystoreToken,
  saveToken as saveKeystoreToken,
  deleteToken as deleteKeystoreToken,
} from '../../../lib/keychain';
import { openBrowser } from '../../../lib/browser';
import { SonarQubeClient } from '../../../sonarqube/client';
import { startLoopbackServer } from '../../../lib/loopback-server';
import logger from '../../../lib/logger';
import { warn, print, pressEnterKeyPrompt, isMockActive } from '../../../ui';
import { blue } from '../../../ui/colors';

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413;
const MAX_POST_BODY_BYTES = 4096;
const SUCCESS_HTML_TITLE = 'Sonar CLI Authentication';
const SUCCESS_HTML_MESSAGE = 'Authentication Successful';
const SUCCESS_HTML_DESCRIPTION = 'You can close this window and return to the terminal.';

/**
 * Get token from keychain
 */
export async function getToken(serverURL: string, org?: string): Promise<string | null> {
  return await getKeystoreToken(serverURL, org);
}

/**
 * Save token to keychain
 */
export async function saveToken(serverURL: string, token: string, org?: string): Promise<void> {
  await saveKeystoreToken(serverURL, token, org);
}

/**
 * Delete token from keychain
 */
export async function deleteToken(serverURL: string, org?: string): Promise<void> {
  await deleteKeystoreToken(serverURL, org);
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
 * Extract token from POST body JSON
 */
export function extractTokenFromPostBody(body: string): string | undefined {
  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    const token = data.token;
    // Token must be a non-empty string
    if (typeof token === 'string' && token.length > 0) {
      return token;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract token from GET query parameters
 */
export function extractTokenFromQuery(
  host: string | undefined,
  url: string | undefined,
): string | undefined {
  if (!host || !url) return undefined;
  try {
    const fullUrl = new URL(`http://${host}${url}`);
    const token = fullUrl.searchParams.get('token');
    // Token must be a non-empty string
    if (token && token.length > 0) {
      return token;
    }
    return undefined;
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
 * Get success HTML page
 */
export function getSuccessHTML(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>${SUCCESS_HTML_TITLE}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: #f5f5f5;
    }
    .container {
      background: white;
      padding: 40px;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      text-align: center;
    }
    .success {
      color: #52c41a;
      font-size: 48px;
      margin-bottom: 20px;
    }
    h1 {
      color: #333;
      margin-bottom: 10px;
    }
    p {
      color: #666;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="success">✓</div>
    <h1>${SUCCESS_HTML_MESSAGE}</h1>
    <p>${SUCCESS_HTML_DESCRIPTION}</p>
  </div>
</body>
</html>
`;
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
  extractedToken?: string,
  onToken?: (token: string) => void,
): void {
  res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'text/html' });
  res.end(getSuccessHTML());
  if (extractedToken && onToken) {
    onToken(extractedToken);
  }
}

/**
 * Handle POST request - read body and extract token
 */
export function handlePostRequest(
  req: IncomingMessage,
  res: ServerResponse,
  onToken: (token: string) => void,
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
    const extractedToken = extractTokenFromPostBody(body);
    sendSuccessResponse(res, extractedToken ?? undefined, onToken);
  });
}

/**
 * Handle GET request - extract token from query parameters
 */
export function handleGetRequest(
  req: IncomingMessage,
  res: ServerResponse,
  onToken: (token: string) => void,
): void {
  const extractedToken = extractTokenFromQuery(req.headers.host, req.url);
  sendSuccessResponse(res, extractedToken ?? undefined, onToken);
}

/**
 * Create request handler for loopback server
 */
export function createRequestHandler(onToken: (token: string) => void) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST') {
      handlePostRequest(req, res, onToken);
    } else if (req.method === 'GET') {
      handleGetRequest(req, res, onToken);
    } else {
      res.writeHead(HTTP_STATUS_OK);
      res.end('OK');
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
 */
export async function waitForTokenInteractive(
  serverTokenPromise: Promise<string>,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    /** Only call rl.close() once; skip when we're already inside the 'close' handler (e.g. Ctrl+C). */
    let rlClosed = false;

    function settle(token?: string, err?: Error): void {
      if (settled) return;
      settled = true;
      if (!rlClosed) {
        rlClosed = true;
        rl.close();
        process.stdin.resume(); // so next prompt (e.g. org key) receives keypresses on Windows
      }
      if (err) reject(err);
      else resolve(token ?? '');
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.on('close', () => {
      if (!settled) settle(undefined, new Error('Authentication cancelled'));
    });

    serverTokenPromise
      .then((token) => {
        settle(token);
      })
      .catch(() => undefined);

    print('  ⏳  Waiting for authorization... or paste token and press Enter:');
    rl.question('', (line) => {
      if (settled) return;
      const userToken = line.trim();
      if (userToken.length > 0) settle(userToken);
    });
  });
}

/**
 * Generate token via browser OAuth flow
 */
export async function generateTokenViaBrowser(
  serverURL: string,
  openBrowserFn: (url: string) => Promise<void> = openBrowserWithFallback,
): Promise<string> {
  let resolveToken: ((token: string) => void) | null = null;

  const tokenPromise = new Promise<string>((resolve) => {
    resolveToken = resolve;
  });

  // Allow the Sonar server origin so the OAuth callback POST is not blocked by DNS rebinding protection
  const serverOrigin = new URL(serverURL).origin;
  const server = await startLoopbackServer(
    createRequestHandler((token: string) => {
      if (resolveToken) {
        resolveToken(token);
      }
    }),
    { allowedOrigins: [serverOrigin] },
  );

  const authURL = buildAuthURL(serverURL, server.port);

  print('🔑 Obtaining access token from SonarQube...');
  print(`URL: ${blue(authURL)}`);
  await pressEnterKeyPrompt('Press Enter to open the browser');
  await openBrowserFn(authURL);

  let token: string | undefined;
  try {
    if (isMockActive() || process.env.CI === 'true') {
      // Non-interactive: wait for server token
      token = await tokenPromise;
    } else {
      // Interactive: race between browser delivery and manual paste
      token = await waitForTokenInteractive(tokenPromise);
    }
  } finally {
    await server.close().catch((err: unknown) => {
      logger.warn(`Auth server shutdown error: ${(err as Error).message}`);
    });
  }

  return token;
}
