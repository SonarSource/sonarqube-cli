// Auth module - OAuth flow and token management

import type { IncomingMessage, ServerResponse } from 'node:http';
import { TextPrompt, isCancel } from '@clack/core';
import { getToken as getKeystoreToken, saveToken as saveKeystoreToken, deleteToken as deleteKeystoreToken } from '../lib/keychain.js';
import { openBrowser } from '../lib/browser.js';
import { SonarQubeClient } from '../sonarqube/client.js';
import { startLoopbackServer } from '../lib/loopback-server.js';
import logger from '../lib/logger.js';
import { warn, print, pressEnterPrompt, isMockActive } from '../ui/index.js';
import { green, dim } from '../ui/colors.js';

const PORT_TIMEOUT_MS = 50000;
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
export function extractTokenFromQuery(host: string | undefined, url: string | undefined): string | undefined {
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
  if (serverURL.includes("sonarcloud") || serverURL.includes("sonarqube.us")) {
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
  if (process.env['CI'] === 'true') {
    return;
  }
  try {
    await openBrowser(authURL);
  } catch (error) {
    warn(`Failed to open browser automatically: ${error}`);
    print('Copy the URL above and open it manually');
  }
}

/**
 * Send success response to HTTP client
 */
export function sendSuccessResponse(res: ServerResponse, extractedToken?: string, onToken?: (token: string) => void): void {
  res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'text/html' });
  res.end(getSuccessHTML());
  if (extractedToken && onToken) {
    onToken(extractedToken);
  }
}

/**
 * Handle POST request - read body and extract token
 */
export function handlePostRequest(req: IncomingMessage, res: ServerResponse, onToken: (token: string) => void): void {
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
export function handleGetRequest(req: IncomingMessage, res: ServerResponse, onToken: (token: string) => void): void {
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
 * Rejects on timeout (50s) or Ctrl+C cancellation.
 */
async function waitForTokenInteractive(serverTokenPromise: Promise<string>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const promptAbort = new AbortController();
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    function settle(token?: string, err?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      promptAbort.abort();
      if (err) reject(err);
      else resolve(token!);
    }

    timeoutId = setTimeout(
      () => settle(undefined, new Error('Timeout waiting for token (50 seconds)')),
      PORT_TIMEOUT_MS
    );

    serverTokenPromise.then(token => settle(token)).catch(() => {});

    const prompt = new TextPrompt({
      signal: promptAbort.signal,
      render() {
        if (this.state === 'submit') return `  ${green('✓')}  Token accepted`;
        if (this.state === 'cancel') return undefined;
        return [
          `  ${dim('›')}  Waiting for browser... or paste token and press Enter:`,
          `  ${dim('›')} ${this.userInputWithCursor}`,
        ].join('\n');
      },
    });

    prompt.prompt().then(result => {
      if (promptAbort.signal.aborted) return;
      if (isCancel(result)) {
        settle(undefined, new Error('Authentication cancelled'));
        return;
      }
      const userToken = (result as string).trim();
      if (userToken.length > 0) settle(userToken);
    }).catch((err: unknown) => settle(undefined, err as Error));
  });
}

/**
 * Generate token via browser OAuth flow
 */
export async function generateTokenViaBrowser(
  serverURL: string,
  openBrowserFn: (url: string) => Promise<void> = openBrowserWithFallback
): Promise<string> {

  let resolveToken: ((token: string) => void) | null = null;

  const tokenPromise = new Promise<string>(resolve => {
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
    { allowedOrigins: [serverOrigin] }
  );

  const authURL = buildAuthURL(serverURL, server.port);

  print('Obtaining access token from SonarQube...');
  print(`URL: ${authURL}`);
  await pressEnterPrompt('Press Enter to open browser');
  await openBrowserFn(authURL);

  let token: string | undefined;
  try {
    if (isMockActive() || process.env['CI'] === 'true') {
      // Non-interactive: wait for server token with timeout
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        token = await Promise.race([
          tokenPromise,
          new Promise<string>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error('Timeout waiting for token (50 seconds)')),
              PORT_TIMEOUT_MS
            );
          }),
        ]);
      } finally {
        clearTimeout(timeoutId);
      }
    } else {
      // Interactive: race between browser delivery and manual paste
      token = await waitForTokenInteractive(tokenPromise);
    }
  } finally {
    server.close().then(
      () => {},
      (err: unknown) => {
        logger.warn(`Auth server shutdown error: ${(err as Error).message}`);
      }
    );
  }

  return token;
}
