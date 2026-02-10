// Auth module - OAuth flow and token management

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { getToken as getKeychainToken, saveToken as saveKeychainToken, deleteToken as deleteKeychainToken } from '../lib/keychain.js';
import { openBrowser } from '../lib/browser.js';
import { SonarQubeClient } from '../sonarqube/client.js';

const MIN_PORT = 64130;
const MAX_PORT = 64140;
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_NOT_FOUND = 404;
const PORT_TIMEOUT_MS = 50000;
const TOKEN_ENDPOINT = '/sonarlint/api/token';
const TOKEN_QUERY_PREFIX = '/?token=';

/**
 * Get token from keychain
 */
export async function getToken(serverURL: string, org?: string): Promise<string | null> {
  return await getKeychainToken(serverURL, org);
}

/**
 * Save token to keychain
 */
export async function saveToken(serverURL: string, token: string, org?: string): Promise<void> {
  await saveKeychainToken(serverURL, token, org);
}

/**
 * Delete token from keychain
 */
export async function deleteToken(serverURL: string, org?: string): Promise<void> {
  await deleteKeychainToken(serverURL, org);
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
 * Generate token via browser OAuth flow
 */
export async function generateTokenViaBrowser(serverURL: string): Promise<string> {
  console.log('\n[DEBUG] Starting token generation flow...');

  // 1. Start embedded HTTP server
  const { port, tokenPromise, shutdown } = await startEmbeddedServer();
  console.log(`[DEBUG] HTTP server started on port ${port}`);

  // 2. Build auth URL
  const cleanServerURL = serverURL.replace(/\/$/, '');
  const authURL = `${cleanServerURL}/sonarlint/auth?ideName=sonar-cli&port=${port}`;

  // 3. Show prompt
  console.log('\n🔑 Obtaining access token from SonarQube...');
  console.log(`\n   URL: ${authURL}`);
  console.log('\n   Press Enter to open browser');
  console.log('   ');

  // Wait for user to press Enter
  await new Promise<void>(resolve => {
    process.stdin.once('data', () => resolve());
  });

  // 4. Open browser
  console.log('[DEBUG] Opening browser...');
  try {
    await openBrowser(authURL);
  } catch (error) {
    console.log(`   ⚠️  Failed to open browser automatically: ${error}`);
    console.log('   Copy the URL above and open it manually');
  }

  console.log('\n   ⏳ Waiting for authorization (50 second timeout)...');
  console.log(`[DEBUG] Waiting for callback on http://127.0.0.1:${port}`);

  // 5. Wait for token with timeout (50 seconds)
  try {
    const token = await Promise.race([
      tokenPromise,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout waiting for token (50 seconds)')), PORT_TIMEOUT_MS)
      )
    ]);

    console.log(`[DEBUG] Token received (length: ${token.length})`);

    if (!token) {
      throw new Error('Received empty token');
    }

    return token;
  } finally {
    shutdown();
  }
}

/**
 * Start embedded HTTP server to receive token callback
 */
async function startEmbeddedServer(): Promise<{
  port: number;
  tokenPromise: Promise<string>;
  shutdown: () => void;
}> {
  console.log('[DEBUG] Creating token promise...');

  let resolveToken: (token: string) => void;
  const tokenPromise = new Promise<string>(resolve => {
    resolveToken = resolve;
  });

  // Try to find an available port
  console.log(`[DEBUG] Searching for available port in range ${MIN_PORT}-${MAX_PORT}...`);

  let port: number | null = null;
  let server: ReturnType<typeof createServer> | null = null;

  for (let p = MIN_PORT; p <= MAX_PORT; p++) {
    try {
      const testServer = createServer();
      const listening = await new Promise<boolean>((resolve) => {
        testServer.once('error', () => {
          console.log(`[DEBUG] Port ${p} is busy`);
          resolve(false);
        });
        testServer.listen(p, '127.0.0.1', () => {
          console.log(`[DEBUG] Port ${p} is available`);
          resolve(true);
        });
      });

      if (listening) {
        port = p;
        server = testServer;
        break;
      }
    } catch (error) {
      console.log(`[DEBUG] Port ${p} error: ${error}`);
    }
  }

  if (!server || !port) {
    throw new Error(`No available ports in range ${MIN_PORT}-${MAX_PORT}`);
  }

  console.log(`[DEBUG] Listener created on 127.0.0.1:${port}`);

  // Set up request handler
  const finalServer = server;
  finalServer.on('request', (req, res) => {
    console.log(`[DEBUG] Received HTTP request: ${req.method} ${req.url}`);

    if (req.url === TOKEN_ENDPOINT && req.method === 'POST') {
      handleTokenPOST(req, res, resolveToken);
    } else if (req.url?.startsWith(TOKEN_QUERY_PREFIX) && req.method === 'GET') {
      // Legacy fallback: GET with query parameter
      handleTokenGET(req, res, resolveToken);
    } else {
      console.log(`[DEBUG] Unknown endpoint: ${req.method} ${req.url}`);
      res.writeHead(HTTP_STATUS_NOT_FOUND);
      res.end('Not Found');
    }
  });

  const shutdown = () => {
    console.log('[DEBUG] Shutting down embedded server...');
    finalServer.close();
  };

  return { port, tokenPromise, shutdown };
}

/**
 * Handle POST /sonarlint/api/token
 */
function handleTokenPOST(
  req: IncomingMessage,
  res: ServerResponse,
  resolveToken: (token: string) => void
): void {
  let body = '';

  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', () => {
    console.log(`[DEBUG] Body content: ${body}`);

    try {
      const data = JSON.parse(body) as Record<string, unknown>;
      const token = data.token;

      if (!token || typeof token !== 'string') {
        console.log('[DEBUG] Token missing or invalid in JSON');
        res.writeHead(HTTP_STATUS_BAD_REQUEST);
        res.end('Invalid token');
        return;
      }

      console.log(`[DEBUG] Token extracted from JSON (length: ${token.length})`);

      // Send success page
      res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'text/html' });
      res.end(getSuccessHTML());

      // Resolve with token
      resolveToken(token);
    } catch (error) {
      console.log(`[DEBUG] Failed to parse JSON: ${error}`);
      res.writeHead(HTTP_STATUS_BAD_REQUEST);
      res.end('Invalid JSON');
    }
  });
}

/**
 * Handle GET /?token= (legacy fallback)
 */
function handleTokenGET(
  req: IncomingMessage,
  res: ServerResponse,
  resolveToken: (token: string) => void
): void {
  const url = new URL(`http://${req.headers.host}${req.url}`);
  const token = url.searchParams.get('token');

  if (!token) {
    console.log('[DEBUG] Token missing in query parameter');
    res.writeHead(HTTP_STATUS_BAD_REQUEST);
    res.end('Token missing');
    return;
  }

  console.log(`[DEBUG] Token extracted from query (length: ${token.length})`);

  // Send success page
  res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'text/html' });
  res.end(getSuccessHTML());

  // Resolve with token
  resolveToken(token);
}

/**
 * Get success HTML page
 */
function getSuccessHTML(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>SonarLint Authentication</title>
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
    <h1>Authentication Successful</h1>
    <p>You can close this window and return to the terminal.</p>
  </div>
</body>
</html>
`;
}
