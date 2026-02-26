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

// Loopback HTTP server with security headers and DNS rebinding protection

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import logger from './logger.js';
import { AUTH_PORT_START, AUTH_PORT_COUNT } from './config-constants.js';

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
 * Attempt to bind a fresh HTTP server to a specific port on 127.0.0.1.
 * Returns the bound server on success; on EADDRINUSE returns null (caller tries next port).
 * Other errors are propagated immediately.
 */
async function tryBindPort(port: number): Promise<{ srv: ReturnType<typeof createServer>; port: number } | null> {
  const srv = createServer();
  return new Promise((resolve, reject) => {
    srv.once('error', (err: NodeJS.ErrnoException) => {
      srv.close();
      if (err.code === 'EADDRINUSE') {
        resolve(null);
      } else {
        reject(err);
      }
    });
    srv.listen(port, '127.0.0.1', () => {
      const address = srv.address();
      if (!address || typeof address === 'string') {
        srv.close();
        reject(new Error('Failed to get server address'));
        return;
      }
      resolve({ srv, port: address.port });
    });
  });
}

export async function startLoopbackServer(
  onRequest: RequestHandler,
  options?: LoopbackServerOptions
): Promise<LoopbackServerResult> {
  // Try each port in the SonarLint protocol range (64120-64130).
  // SonarQube/SonarCloud validates that the callback port is within this range
  // before sending the token — a random OS-assigned port is rejected.
  let bound: { srv: ReturnType<typeof createServer>; port: number } | null = null;
  for (let i = 0; i < AUTH_PORT_COUNT; i++) {
    const candidate = AUTH_PORT_START + i;
    bound = await tryBindPort(candidate);
    if (bound !== null) break;
    logger.debug(`Port ${candidate} in use, trying next`);
  }

  if (bound === null) {
    throw new Error(`No available port in SonarLint range ${AUTH_PORT_START}-${AUTH_PORT_START + AUTH_PORT_COUNT - 1}`);
  }

  const { srv: finalServer, port: foundPort } = bound;
  const allowedOrigins = options?.allowedOrigins ?? [];

  // Also bind to IPv6 loopback on the same port.
  // On macOS, dns.lookup('localhost') returns ::1 before 127.0.0.1, so browsers
  // connect to [::1]:PORT first. Without this binding the OAuth callback from
  // SonarCloud gets ECONNREFUSED and the token never arrives.
  const serverV6 = createServer();
  let ipv6Available = false;
  await new Promise<void>(resolve => {
    serverV6.once('error', () => {
      logger.debug('IPv6 loopback [::1] not available; using IPv4 only');
      resolve();
    });
    serverV6.listen(foundPort, '::1', () => {
      ipv6Available = true;
      resolve();
    });
  });

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
          preflightHeaders['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
          preflightHeaders['Access-Control-Allow-Headers'] = 'Content-Type';
          // Required for Chrome Private Network Access (PNA) policy:
          // public origins (e.g. https://sonarcloud.io) fetching localhost get blocked
          // unless the preflight response includes this header.
          preflightHeaders['Access-Control-Allow-Private-Network'] = 'true';
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

  // Set up secure request handler on both IPv4 and IPv6 servers
  const wrappedHandler = wrapResponseWithSecurityHeaders(onRequest);
  finalServer.on('request', wrappedHandler);
  if (ipv6Available) {
    serverV6.on('request', wrappedHandler);
  }

  function closeServer(srv: ReturnType<typeof createServer>): Promise<void> {
    return new Promise<void>((resolve) => {
      srv.close(() => {
        resolve();
      });

      const forceCloseTimer = setTimeout(() => {
        srv.closeAllConnections?.();
      }, FORCE_CLOSE_TIMEOUT_MS);

      forceCloseTimer.unref();
    });
  }

  const close = async (): Promise<void> => {
    const pending: Promise<void>[] = [closeServer(finalServer)];
    if (ipv6Available) {
      pending.push(closeServer(serverV6));
    }
    await Promise.all(pending);
  };

  return { port: foundPort, close };
}
