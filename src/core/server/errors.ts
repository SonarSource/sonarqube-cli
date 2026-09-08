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

/**
 * Wraps a failure that happened before a response was received at all: the request
 * never reached the server, or never came back (DNS/TLS/proxy failure, connection
 * refused, timeout, abort). Distinct from every other error in this file, which is
 * built from an actual HTTP response.
 */
import { NetworkConfigError } from '@/core/errors.ts';

export class TransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransportError';
  }
}

/** Thrown by the API client on HTTP 429 (Too Many Requests). */
export class RateLimitError extends Error {
  constructor() {
    super('Rate limit reached (429). Wait a moment and try again.');
    this.name = 'RateLimitError';
  }
}

/** Thrown by the API client on HTTP 503 (Service Unavailable). */
export class ServiceUnavailableError extends Error {
  constructor() {
    super('Server busy (503). The service is temporarily unavailable.');
    this.name = 'ServiceUnavailableError';
  }
}

/** Thrown by the API client on HTTP 400 (Bad Request) for structured SQAA/API errors. */
export class BadRequestError extends Error {
  readonly code?: string;
  readonly meta?: Record<string, unknown>;

  constructor(message: string, code?: string, meta?: Record<string, unknown>) {
    super(message);
    this.name = 'BadRequestError';
    this.code = code;
    this.meta = meta;
  }
}

/** Thrown by the API client on any 5xx response other than 503 (Service Unavailable). */
export class ServerError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ServerError';
    this.status = status;
  }
}

/** Thrown by the API client on a GET HTTP 403 or 404 response. */
export class AccessDeniedError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(
      `Access denied (HTTP ${status}). Check that the supplied token and organization are valid.`,
    );
    this.name = 'AccessDeniedError';
    this.status = status;
  }
}

/** Thrown by the API client on any response status not classified by one of the above. */
export class UnexpectedApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'UnexpectedApiError';
    this.status = status;
  }
}

export type RequestPayloadTooLargeCode = 'REQUEST_TOO_LARGE' | 'TOO_MANY_FILES';

export interface RequestPayloadTooLargeMeta {
  maxRequestSize?: number;
  maxFiles?: number;
}

/** Thrown by the API client on any HTTP 403 (Forbidden) POST response. */
export class ForbiddenApiError extends Error {
  constructor(body: string) {
    super(body);
    this.name = 'ForbiddenApiError';
  }
}

/** Thrown when the SQAA analysis endpoint returns 403 — Agentic Pack entitlement revoked. */
export class SqaaForbiddenError extends Error {
  constructor() {
    super('Vortex analysis is not available on this connection (403 Forbidden).');
    this.name = 'SqaaForbiddenError';
  }
}

/** Thrown by the API client on HTTP 413 (Payload Too Large) for SQAA requests. */
export class RequestPayloadTooLargeError extends Error {
  readonly code?: RequestPayloadTooLargeCode;
  readonly meta?: RequestPayloadTooLargeMeta;

  constructor(
    message: string,
    code?: RequestPayloadTooLargeCode,
    meta?: RequestPayloadTooLargeMeta,
  ) {
    super(message);
    this.name = 'RequestPayloadTooLargeError';
    this.code = code;
    this.meta = meta;
  }
}

/**
 * The closed set of errors a `SonarHttpClient` method can resolve to. Parameterising
 * `Result`/`ResultAsync` with this union, instead of the base `Error`, is what makes
 * `.mapErr()` and a `switch` on `error.name` exhaustive at the call site.
 */
export type HttpClientError =
  | TransportError
  | NetworkConfigError
  | RateLimitError
  | ServiceUnavailableError
  | BadRequestError
  | ServerError
  | ForbiddenApiError
  | RequestPayloadTooLargeError
  | AccessDeniedError
  | UnexpectedApiError;

/**
 * Distinguishes a critical failure (the request could not be carried out at all, or
 * the server is rejecting all traffic) from an expected one, a well-formed rejection
 * of this particular request that a caller may reasonably treat as a normal outcome
 * (e.g. "this organization doesn't exist").
 *
 * `Result`-returning `SonarHttpClient` methods don't apply this themselves: they hand
 * back whichever error they built, critical or not, and leave the decision to the
 * caller. Swallow-to-fallback call sites should check this before discarding an error,
 * so an outage or a misconfigured proxy fails loudly instead of looking like the normal
 * "not found" case it is being folded into.
 */
export function isCriticalFailure(error: Error): boolean {
  return (
    error instanceof TransportError ||
    error instanceof NetworkConfigError ||
    error instanceof RateLimitError ||
    error instanceof ServiceUnavailableError ||
    error instanceof ServerError
  );
}
