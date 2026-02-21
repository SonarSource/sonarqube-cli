// Auth module - OAuth flow and token management

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getToken as getKeystoreToken, saveToken as saveKeystoreToken, deleteToken as deleteKeystoreToken } from '../lib/keychain.js';
import { openBrowser } from '../lib/browser.js';
import { SonarQubeClient } from '../sonarqube/client.js';
import { startLoopbackServer } from '../lib/loopback-server.js';
import logger from '../lib/logger.js';
import { warn, print, pressEnterPrompt } from '../ui';

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
 * Open browser, with fallback message if it fails
 */
export async function openBrowserWithFallback(authURL: string): Promise<void> {
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
 * Generate token via browser OAuth flow
 */
export async function generateTokenViaBrowser(serverURL: string): Promise<string> {

  let resolveToken: ((token: string) => void) | null = null;

  const tokenPromise = new Promise<string>(resolve => {
    resolveToken = resolve;
  });

  // 1. Start embedded HTTP server with token extraction handler
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

  // 2. Build auth URL
  const authURL = buildAuthURL(serverURL, server.port);

  // 3. Show prompt and wait for user input
  print('Obtaining access token from SonarQube...');
  print(`URL: ${authURL}`);
  await pressEnterPrompt('Press Enter to open browser');

  // 5. Open browser
  await openBrowserWithFallback(authURL);

  print('Waiting for authorization (50 second timeout)...');

  // 6. Wait for token with timeout (50 seconds)
  let token: string | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    token = await Promise.race([
      tokenPromise,
      new Promise<string>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Timeout waiting for token (50 seconds)')), PORT_TIMEOUT_MS);
      })
    ]);

    if (!token) {
      throw new Error('Received empty token');
    }
  } finally {
    clearTimeout(timeoutId);
    server.close().then(
      () => {},
      (err: unknown) => {
        logger.warn(`Auth server shutdown error: ${(err as Error).message}`);
      }
    );
  }

  return token;
}
