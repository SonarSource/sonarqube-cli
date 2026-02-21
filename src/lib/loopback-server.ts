// Loopback HTTP server with security headers and DNS rebinding protection

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import logger from './logger.js';

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
 * Validate if Host header points to a loopback address
 * Defense-in-depth against DNS rebinding attacks (complements Origin check)
 */
export function isValidLoopbackHost(host: string): boolean {
  try {
    // Host header is "hostname:port" or just "hostname" — prepend scheme to parse
    const url = new URL(`http://${host}`);
    return ALLOWED_LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    logger.debug(`Invalid Host header format: ${host}`);
    return false;
  }
}

/**
 * Merge security headers with user-provided headers
 */
function mergeSecurityHeadersWithUserHeaders(
  userHeaders?: Record<string, string> | string | string[]
): Record<string, string> {
  const securityHeaders = getSecurityHeaders();

  if (userHeaders && typeof userHeaders === 'object' && !Array.isArray(userHeaders)) {
    Object.entries(userHeaders).forEach(([key, value]) => {
      securityHeaders[key] = value;
    });
  }

  return securityHeaders;
}

export interface LoopbackServerOptions {
  /** Additional origins (beyond loopback) that are allowed to make requests */
  allowedOrigins?: string[];
}

/**
 * Start a secure loopback HTTP server on an OS-assigned random port
 *
 * @param onRequest - Handler function for incoming requests
 * @param options - Optional server configuration
 * @returns Promise with port and close function
 */
export async function startLoopbackServer(
  onRequest: RequestHandler,
  options?: LoopbackServerOptions
): Promise<LoopbackServerResult> {
  const server = createServer();

  const foundPort = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }
      resolve(address.port);
    });
  });

  const finalServer = server;
  const allowedOrigins = options?.allowedOrigins ?? [];

  // Helper to wrap a response with security headers
  function wrapResponseWithSecurityHeaders(
    originalHandler: RequestHandler
  ): RequestHandler {
    return (req, res) => {
      const origin = req.headers.origin;
      const isExternalAllowedOrigin = !!(origin && !isValidLoopbackOrigin(origin) && allowedOrigins.includes(origin));

      // Handle OPTIONS preflight requests
      if (req.method === 'OPTIONS') {
        const preflightHeaders: Record<string, string> = { ...getSecurityHeaders() };
        // Add CORS headers for allowed external origins (e.g. SonarCloud OAuth callback)
        if (origin && (isValidLoopbackOrigin(origin) || allowedOrigins.includes(origin))) {
          preflightHeaders['Access-Control-Allow-Origin'] = origin;
          preflightHeaders['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
          preflightHeaders['Access-Control-Allow-Headers'] = 'Content-Type';
        }
        res.writeHead(HTTP_STATUS_OK, preflightHeaders);
        res.end();
        return;
      }

      // DNS rebinding protection: reject origins that are neither loopback nor explicitly allowed
      if (origin && !isValidLoopbackOrigin(origin) && !allowedOrigins.includes(origin)) {
        logger.warn(`Rejected request from disallowed origin: ${origin}`);
        res.writeHead(HTTP_STATUS_FORBIDDEN);
        res.end('Forbidden');
        return;
      }

      // Host header validation: defense-in-depth against DNS rebinding
      const host = req.headers.host;
      if (host && !isValidLoopbackHost(host)) {
        logger.warn(`Rejected request with non-loopback Host header: ${host}`);
        res.writeHead(HTTP_STATUS_FORBIDDEN);
        res.end('Forbidden');
        return;
      }

      // Store original writeHead
      const originalWriteHead = res.writeHead;

      // Define wrapper function (avoids type assertion)
      function writeHeadWithSecurityHeaders(
        statusCode: number,
        headers?: Record<string, string> | string | string[]
      ): typeof res {
        const mergedHeaders = mergeSecurityHeadersWithUserHeaders(headers);
        // Inject CORS header for external allowed origins (e.g. SonarCloud OAuth callback)
        if (isExternalAllowedOrigin && origin) {
          mergedHeaders['Access-Control-Allow-Origin'] = origin;
        }
        return originalWriteHead.call(res, statusCode, mergedHeaders);
      }

      // Replace writeHead on the response object using defineProperty to avoid type assertions
      Object.defineProperty(res, 'writeHead', {
        value: writeHeadWithSecurityHeaders,
        writable: true,
        configurable: true,
      });

      // Call user handler
      originalHandler(req, res);
    };
  }

  // Set up secure request handler
  finalServer.on('request', wrapResponseWithSecurityHeaders(onRequest));

  const close = async (): Promise<void> => {
    return new Promise<void>((resolve) => {
      finalServer.close(() => {
        resolve();
      });

      // Force close any remaining connections after timeout
      const forceCloseTimer = setTimeout(() => {
        finalServer.closeAllConnections?.();
      }, FORCE_CLOSE_TIMEOUT_MS);

      forceCloseTimer.unref();
    });
  };

  return { port: foundPort, close };
}
