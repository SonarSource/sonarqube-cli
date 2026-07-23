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
    super('Vortex agentic analysis is not available for this organization (403 Forbidden).');
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
