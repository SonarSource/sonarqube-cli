// Loopback HTTP server with security headers and DNS rebinding protection

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import logger from './logger.js';

const MIN_PORT = 64130;
const MAX_PORT = 64140;
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_FORBIDDEN = 403;
const FORCE_CLOSE_TIMEOUT_MS = 2000;
const ALLOWED_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface LoopbackServerResult {
  port: number;
  close: () => Promise<void>;
}

export type RequestHandler = (
  req: IncomingMessage,
  res: ServerResponse
) => void;

/**
 * Get security headers for loopback server response
 */
export function getSecurityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': "default-src 'none'; connect-src 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  };
}

/**
 * Validate if origin is an allowed loopback address (localhost, 127.0.0.1, [::1])
 * Used for DNS rebinding attack prevention
 */
export function isValidLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return ALLOWED_LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    logger.debug(`Invalid origin URL format: ${origin}`);
    return false;
  }
}

/**
 * Start a secure loopback HTTP server
 *
 * @param onRequest - Handler function for incoming requests
 * @param options - Optional configuration (e.g., port range)
 * @returns Promise with port and close function
 */
export async function startLoopbackServer(
  onRequest: RequestHandler,
  options?: { portRange?: [number, number] }
): Promise<LoopbackServerResult> {
  const portRange: [number, number] = options?.portRange ?? [MIN_PORT, MAX_PORT];
  const [minPort, maxPort] = portRange;

  logger.debug(`Searching for available port in range ${minPort}-${maxPort}...`);

  let foundPort: number | null = null;
  let server: ReturnType<typeof createServer> | null = null;

  for (let p = minPort; p <= maxPort; p++) {
    try {
      const testServer = createServer();
      const listening = await new Promise<boolean>((resolve) => {
        testServer.once('error', (err) => {
          logger.debug(`Port ${p} is busy: ${(err as Error).message}`);
          resolve(false);
        });
        testServer.listen(p, '127.0.0.1', () => {
          logger.debug(`Port ${p} is available`);
          resolve(true);
        });
      });

      if (listening) {
        foundPort = p;
        server = testServer;
        break;
      }
    } catch (error) {
      logger.debug(`Port ${p} error: ${error}`);
    }
  }

  if (!server || foundPort === null) {
    throw new Error(`No available ports in range ${minPort}-${maxPort}`);
  }

  logger.debug(`Loopback server created on 127.0.0.1:${foundPort}`);

  const finalServer = server;

  // Set up secure request handler with security headers and origin validation
  finalServer.on('request', (req, res) => {
    const origin = req.headers.origin;

    // Handle OPTIONS preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(HTTP_STATUS_OK, getSecurityHeaders());
      res.end();
      return;
    }

    // DNS rebinding protection: reject non-localhost origins
    if (origin && !isValidLoopbackOrigin(origin)) {
      logger.warn(`Rejected request from disallowed origin: ${origin}`);
      res.writeHead(HTTP_STATUS_FORBIDDEN);
      res.end('Forbidden');
      return;
    }

    // Wrap res.writeHead to inject security headers
    const originalWriteHead = res.writeHead.bind(res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).writeHead = (statusCode: number, maybeHeaders?: any): any => {
      const securityHeaders = getSecurityHeaders();
      if (maybeHeaders && typeof maybeHeaders === 'object') {
        Object.entries(maybeHeaders).forEach(([key, value]) => {
          if (typeof value === 'string') {
            securityHeaders[key] = value;
          }
        });
      }
      return originalWriteHead(statusCode, securityHeaders);
    };

    // Call user-provided request handler
    onRequest(req, res);
  });

  const close = async (): Promise<void> => {
    logger.debug('Closing loopback server...');

    return new Promise<void>((resolve) => {
      finalServer.close(() => {
        logger.debug('Loopback server closed successfully');
        resolve();
      });

      // Force close any remaining connections after timeout
      const forceCloseTimer = setTimeout(() => {
        logger.debug('Force closing remaining loopback connections');
        finalServer.closeAllConnections?.();
      }, FORCE_CLOSE_TIMEOUT_MS);

      forceCloseTimer.unref();
    });
  };

  return { port: foundPort, close };
}
