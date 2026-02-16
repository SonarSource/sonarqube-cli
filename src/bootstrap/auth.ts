// Auth module - OAuth flow and token management

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { VERSION } from '../version.js';
import { getToken as getKeystoreToken, saveToken as saveKeystoreToken, deleteToken as deleteKeystoreToken } from '../lib/keychain.js';
import { openBrowser } from '../lib/browser.js';
import { SonarQubeClient } from '../sonarqube/client.js';
import logger from '../lib/logger.js';

const MIN_PORT = 64130;
const MAX_PORT = 64140;
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_BAD_REQUEST = 400;
const PORT_TIMEOUT_MS = 50000;
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
 * Generate token via browser OAuth flow
 */
export async function generateTokenViaBrowser(serverURL: string): Promise<string> {
  logger.debug(`=== AUTH FLOW v${VERSION} ===`);
  logger.debug('Starting token generation flow...');

  // 1. Start embedded HTTP server
  const { port, tokenPromise, shutdown } = await startEmbeddedServer();
  logger.debug(`HTTP server started on port ${port}`);

  // 2. Build auth URL
  const cleanServerURL = serverURL.replace(/\/$/, '');
  const authURL = `${cleanServerURL}/sonarlint/auth?ideName=sonar-cli&port=${port}`;

  // 3. Show prompt
  logger.info('\n🔑 Obtaining access token from SonarQube...');
  logger.info(`\n   URL: ${authURL}`);
  logger.info('\n   Press Enter to open browser');
  logger.info('   ');

  // Wait for user to press Enter and ensure stdin is closed after
  const userPressedEnter = new Promise<void>(resolve => {
    const onData = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      process.stdin.unref();
      resolve();
    };
    process.stdin.once('data', onData);
  });

  await userPressedEnter;

  // 4. Open browser
  logger.debug('Opening browser...');
  try {
    await openBrowser(authURL);
  } catch (error) {
    logger.info(`   ⚠️  Failed to open browser automatically: ${error}`);
    logger.info('   Copy the URL above and open it manually');
  }

  logger.info('\n   ⏳ Waiting for authorization (50 second timeout)...');
  logger.debug(`Waiting for callback on http://127.0.0.1:${port}`);

  // 5. Wait for token with timeout (50 seconds)
  let token: string | undefined;
  try {
    token = await Promise.race([
      tokenPromise,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout waiting for token (50 seconds)')), PORT_TIMEOUT_MS)
      )
    ]);

    logger.debug(`Token received (length: ${token.length})`);

    if (!token) {
      throw new Error('Received empty token');
    }
  } finally {
    // Always shutdown and ensure all resources are cleaned up
    await shutdown();
  }

  return token;
}

/**
 * Start embedded HTTP server to receive token callback
 */
async function startEmbeddedServer(): Promise<{
  port: number;
  tokenPromise: Promise<string>;
  shutdown: () => void;
}> {
  logger.debug('Creating token promise...');

  let resolveToken: (token: string) => void;
  const tokenPromise = new Promise<string>(resolve => {
    resolveToken = resolve;
  });

  // Try to find an available port
  logger.debug(`Searching for available port in range ${MIN_PORT}-${MAX_PORT}...`);

  let port: number | null = null;
  let server: ReturnType<typeof createServer> | null = null;

  for (let p = MIN_PORT; p <= MAX_PORT; p++) {
    try {
      const testServer = createServer();
      const listening = await new Promise<boolean>((resolve) => {
        testServer.once('error', () => {
          logger.debug(`Port ${p} is busy`);
          resolve(false);
        });
        testServer.listen(p, '127.0.0.1', () => {
          logger.debug(`Port ${p} is available`);
          resolve(true);
        });
      });

      if (listening) {
        port = p;
        server = testServer;
        break;
      }
    } catch (error) {
      logger.debug(`Port ${p} error: ${error}`);
      continue;
    }
  }

  if (!server || !port) {
    throw new Error(`No available ports in range ${MIN_PORT}-${MAX_PORT}`);
  }

  logger.debug(`Listener created on 127.0.0.1:${port}`);

  // Set up connection handler (low-level socket events)
  const finalServer = server;
  finalServer.on('connection', (socket) => {
    const remoteAddr = socket.remoteAddress;
    const remotePort = socket.remotePort;
    logger.debug(`NEW CONNECTION from ${remoteAddr}:${remotePort}`);

    socket.on('data', (chunk) => {
      logger.debug(`Socket received ${chunk.length} bytes`);
    });

    socket.on('error', (error) => {
      logger.debug(`Socket error: ${(error as Error).message}`);
    });

    socket.on('end', () => {
      logger.debug('Socket connection ended');
    });
  });

  // Set up request handler - catch ALL requests
  finalServer.on('request', (req, res) => {
    logger.debug(`*** HTTP REQUEST: ${req.method} ${req.url} ***`);

    // Try to extract token from any request (POST body or GET query)
    if (req.method === 'POST') {
      logger.debug('POST request detected, reading body...');
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        logger.debug(`POST body: ${body}`);
        try {
          const data = JSON.parse(body) as Record<string, unknown>;
          const token = data.token as string | undefined;
          if (token) {
            logger.debug(`✓ Token extracted from POST body: ${token.substring(0, 20)}...`);
            res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'text/html' });
            res.end(getSuccessHTML());
            resolveToken(token);
          }
        } catch {
          logger.debug('Failed to parse POST body as JSON');
        }
      });
    } else if (req.method === 'GET') {
      logger.debug('GET request detected, checking query parameters...');
      try {
        const url = new URL(`http://${req.headers.host}${req.url}`);
        const token = url.searchParams.get('token');
        if (token) {
          logger.debug(`✓ Token extracted from GET query: ${token.substring(0, 20)}...`);
          res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'text/html' });
          res.end(getSuccessHTML());
          resolveToken(token);
          return;
        }
      } catch {
        logger.debug('Failed to parse GET URL');
      }
      // No token in GET, return success anyway (might be just browser check)
      res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'text/html' });
      res.end(getSuccessHTML());
    } else {
      logger.debug(`Unexpected HTTP method: ${req.method}`);
      res.writeHead(HTTP_STATUS_OK);
      res.end('OK');
    }
  });

  const shutdown = async (): Promise<void> => {
    logger.debug('Shutting down embedded server...');

    return new Promise<void>((resolve) => {
      // Close the server and wait for it to finish
      finalServer.close(() => {
        logger.debug('Server closed successfully');
        resolve();
      });

      // Force close any remaining connections after 2 seconds with unref
      const forceCloseTimer = setTimeout(() => {
        logger.debug('Force closing remaining connections');
        finalServer.closeAllConnections?.();
      }, 2000);

      // Don't let this timer keep the process alive
      forceCloseTimer.unref();
    });
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

    try {
      const data = JSON.parse(body) as Record<string, unknown>;
      const token = data.token;

      if (!token || typeof token !== 'string') {
        logger.debug('Token missing or invalid in JSON');
        res.writeHead(HTTP_STATUS_BAD_REQUEST);
        res.end('Invalid token');
        return;
      }

      logger.debug(`Token extracted from JSON (length: ${token.length})`);

      // Send success page
      res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'text/html' });
      res.end(getSuccessHTML());

      // Resolve with token
      resolveToken(token);
    } catch (error) {
      logger.debug(`Failed to parse JSON: ${error}`);
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
    logger.debug('Token missing in query parameter');
    res.writeHead(HTTP_STATUS_BAD_REQUEST);
    res.end('Token missing');
    return;
  }

  logger.debug(`Token extracted from query (length: ${token.length})`);

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
