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

// Low-level HTTP transport for the SonarQube APIs.
//
// This is the only place that knows about headers, timeouts, request bodies and how a
// non-2xx response becomes a typed error. Everything above it — the per-domain API
// wrappers — is written in terms of `get` / `post` and lives next to its callers.

import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_PAYLOAD_TOO_LARGE,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
} from '@/core/http-constants.ts';
import { Err, Ok, type Result } from '@/core/result.ts';
import { print } from '@/core/ui';

import { version as VERSION } from '../../../package.json';
import logger from '../observability/logger.ts';
import {
  BadRequestError,
  ForbiddenApiError,
  RateLimitError,
  RequestPayloadTooLargeError,
  type RequestPayloadTooLargeMeta,
  ServiceUnavailableError,
} from './errors.ts';
import { buildRequest, fetchAuthenticated } from './fetch.ts';
import {
  isSonarQubeCloud,
  normalizeCloudV2Endpoint,
  resolveFromEndpoint,
} from './sonarcloud-region.ts';

const GET_REQUEST_TIMEOUT_MS = 30000; // 30 seconds
const POST_REQUEST_TIMEOUT_MS = 60000; // 60 seconds for analysis

export const GENERIC_HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
export const METHODS_WITH_BODY = new Set<HttpMethod>(['POST', 'PATCH', 'PUT']);
export type HttpMethod = (typeof GENERIC_HTTP_METHODS)[number];
export type QueryParams = Record<string, string | number | boolean>;

/** A GET response together with its parsed body, which is absent on a non-2xx status. */
export interface SafeGetResult<T> {
  response: Response;
  value: T | undefined;
}

export class SonarHttpClient {
  public readonly serverURL: string;
  public readonly isCloud: boolean;
  private readonly token: string;

  constructor(serverURL: string, token: string) {
    this.serverURL = serverURL.replace(/\/$/, ''); // Remove trailing slash
    this.token = token;
    this.isCloud = isSonarQubeCloud(serverURL);
  }

  /**
   * The API host serving `endpoint`. On Cloud several endpoint families live on a
   * region-specific host rather than on the connection URL; on Server it is the
   * connection URL itself. Pass the result as `baseUrl` to `get` / `post`.
   */
  apiHostFor(endpoint: string): string {
    return resolveFromEndpoint(this.serverURL, endpoint);
  }

  private commonHeaders(contentType?: 'json' | 'form'): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': `sonarqube-cli/${VERSION}`,
      Accept: 'application/json',
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (contentType === 'form') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (contentType === 'json') {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  /** Returns the typed error for a non-2xx response, or `undefined` when `response.ok`. */
  private async buildStatusError(
    response: Response,
    method: HttpMethod,
  ): Promise<Error | undefined> {
    if (response.ok) return undefined;

    // Status-specific typed errors apply regardless of HTTP method.
    if (response.status === HTTP_STATUS_TOO_MANY_REQUESTS) {
      return new RateLimitError();
    }
    if (response.status === HTTP_STATUS_SERVICE_UNAVAILABLE) {
      return new ServiceUnavailableError();
    }
    if (method === 'POST' && response.status === HTTP_STATUS_BAD_REQUEST) {
      return await parseBadRequestError(response);
    }
    if (method === 'POST' && response.status === HTTP_STATUS_PAYLOAD_TOO_LARGE) {
      return await parseRequestPayloadTooLargeError(response);
    }
    if (method === 'POST' && response.status === HTTP_STATUS_FORBIDDEN) {
      return new ForbiddenApiError(await response.text());
    }

    if (method === 'GET') {
      if (response.status === HTTP_STATUS_FORBIDDEN || response.status === HTTP_STATUS_NOT_FOUND) {
        return new Error(
          `Access denied (HTTP ${response.status}). Check that the supplied token and organization are valid.`,
        );
      }
      const errorText = await response.text();
      logger.debug(`SonarQube GET ${response.url} failed: ${response.status} ${errorText}`);
      return new Error(`SonarQube API error: ${response.status} ${response.statusText}`);
    }

    const errorText = await response.text();
    return new Error(
      `SonarQube API error: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  /**
   * genericRequest is a generic method to make arbitrary HTTP requests.
   * It should ONLY be used for the `sonar api` command.
   */
  async genericRequest(
    method: HttpMethod,
    endpoint: string,
    data?: string,
    contentType: 'json' | 'form' = 'json',
    debug?: boolean,
  ): Promise<Result<string>> {
    const headers = this.commonHeaders(contentType);
    let requestBody: string | undefined;

    if (data && METHODS_WITH_BODY.has(method)) {
      if (contentType === 'form') {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(parsed)) {
          params.set(key, String(value));
        }
        requestBody = params.toString();
      } else {
        requestBody = data;
      }
    }

    const timeout = method === 'GET' ? GET_REQUEST_TIMEOUT_MS : POST_REQUEST_TIMEOUT_MS;

    const normalizedEndpoint = normalizeCloudV2Endpoint(this.serverURL, endpoint);
    const transformedServerURL = resolveFromEndpoint(this.serverURL, normalizedEndpoint);
    const url = `${transformedServerURL}${normalizedEndpoint}`;

    if (debug) {
      print(`request method: ${method}`, 'stderr');
      print(`request url: ${url}`, 'stderr');
      print(`request headers: ${JSON.stringify(redactSensitiveHeaders(headers))}`, 'stderr');
      print(`request body: ${requestBody}`, 'stderr');
    }

    try {
      const response = await fetchAuthenticated(
        url,
        buildRequest(method, headers, timeout, requestBody),
      );

      if (debug) {
        print(`response status: ${response.status}`, 'stderr');
        print(`response headers: ${JSON.stringify(response.headers)}`, 'stderr');
      }

      const error = await this.buildStatusError(response, method);
      if (error) {
        return Err(error);
      }

      return Ok(await response.text());
    } catch (err) {
      return Err(toError(err));
    }
  }

  /**
   * Make GET request to SonarQube API
   */
  async get<T>(endpoint: string, params?: QueryParams, baseUrl?: string): Promise<Result<T>> {
    try {
      const result = await this.getSafe<T>(endpoint, params, baseUrl);
      return await this.toGetResult(result);
    } catch (err) {
      return Err(toError(err));
    }
  }

  /**
   * Like `get`, but resolves to `Ok(null)` instead of an error when the server responds
   * 404. Every other non-2xx status still yields its normal typed error.
   */
  async getOrNotFound<T>(
    endpoint: string,
    params?: QueryParams,
    baseUrl?: string,
  ): Promise<Result<T | null>> {
    try {
      const result = await this.getSafe<T>(endpoint, params, baseUrl);

      if (result.response.status === HTTP_STATUS_NOT_FOUND) {
        return Ok(null);
      }

      return await this.toGetResult(result);
    } catch (err) {
      return Err(toError(err));
    }
  }

  private async toGetResult<T>(result: SafeGetResult<T>): Promise<Result<T>> {
    const error = await this.buildStatusError(result.response, 'GET');
    if (error) {
      return Err(error);
    }

    if (result.value === undefined) {
      return Err(new Error('SonarQube API error: empty response body'));
    }
    return Ok(result.value);
  }

  async getSafe<TValue>(
    endpoint: string,
    params?: QueryParams,
    baseUrl?: string,
    timeoutMs: number = GET_REQUEST_TIMEOUT_MS,
  ): Promise<SafeGetResult<TValue>> {
    const url = new URL(`${baseUrl ?? this.serverURL}${endpoint}`);

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, String(value));
      });
    }

    const urlString = url.toString();
    const response = await fetchAuthenticated(
      urlString,
      buildRequest('GET', this.commonHeaders(), timeoutMs, undefined),
    );

    const value = response.ok ? ((await response.json()) as TValue) : undefined;

    return { response, value };
  }

  /**
   * Make POST request to SonarQube API using Bearer token
   */
  async post<T>(
    endpoint: string,
    body: unknown,
    baseUrl?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<Result<T>> {
    const url = `${baseUrl ?? this.serverURL}${endpoint}`;
    const headers = { ...this.commonHeaders('json'), ...extraHeaders };

    try {
      const response = await fetchAuthenticated(
        url,
        buildRequest('POST', headers, POST_REQUEST_TIMEOUT_MS, JSON.stringify(body)),
      );

      const error = await this.buildStatusError(response, 'POST');
      if (error) {
        return Err(error);
      }

      return Ok((await response.json()) as T);
    } catch (err) {
      return Err(toError(err));
    }
  }

  /**
   * Generic helper to POST a form-encoded body to a SonarQube endpoint using
   * the configured Bearer token. Resolves to `Err` (never throws) on a non-2xx
   * response, a transport failure, or a malformed body, so callers can handle
   * failures (e.g. best-effort logout).
   */
  async postForm(
    endpoint: string,
    params: Record<string, string>,
    timeoutMs: number = POST_REQUEST_TIMEOUT_MS,
  ): Promise<Result<void>> {
    const url = `${this.serverURL}${endpoint}`;
    try {
      const response = await fetchAuthenticated(
        url,
        buildRequest(
          'POST',
          this.commonHeaders('form'),
          timeoutMs,
          new URLSearchParams(params).toString(),
        ),
      );

      const error = await this.buildStatusError(response, 'POST');
      if (error) {
        return Err(error);
      }
      return Ok(undefined);
    } catch (err) {
      return Err(toError(err));
    }
  }

  /**
   * Like `postForm`, but parses and returns the JSON response body instead of
   * discarding it. Used for legacy endpoints that are
   * form-encoded on the request side but return a JSON body.
   */
  async postFormJson<T>(endpoint: string, params: Record<string, string>): Promise<Result<T>> {
    const url = `${this.serverURL}${endpoint}`;
    try {
      const response = await fetchAuthenticated(
        url,
        buildRequest(
          'POST',
          this.commonHeaders('form'),
          POST_REQUEST_TIMEOUT_MS,
          new URLSearchParams(params).toString(),
        ),
      );

      const error = await this.buildStatusError(response, 'POST');
      if (error) {
        return Err(error);
      }

      return Ok((await response.json()) as T);
    } catch (err) {
      return Err(toError(err));
    }
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function redactSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  if (headers.Authorization) {
    return { ...headers, Authorization: 'REDACTED' };
  }
  return headers;
}

interface StructuredErrorBody {
  message?: string;
  code?: string;
  meta?: RequestPayloadTooLargeMeta | Record<string, unknown>;
}

async function readStructuredErrorBody(response: Response): Promise<{
  body?: StructuredErrorBody;
  text: string;
}> {
  const text = await response.text();
  try {
    return { body: JSON.parse(text) as StructuredErrorBody, text };
  } catch {
    return { text };
  }
}

function badRequestFallbackMessage(response: Response, text: string): string {
  const detail = text ? ' - ' + text : '';
  return `SonarQube API error: ${response.status} ${response.statusText}${detail}`;
}

async function parseBadRequestError(response: Response): Promise<BadRequestError> {
  const { body, text } = await readStructuredErrorBody(response);
  const fallback = badRequestFallbackMessage(response, text);
  if (!body) {
    return new BadRequestError(fallback);
  }
  return new BadRequestError(
    body.message ?? fallback,
    body.code,
    body.meta as Record<string, unknown> | undefined,
  );
}

async function parseRequestPayloadTooLargeError(
  response: Response,
): Promise<RequestPayloadTooLargeError> {
  const { body, text } = await readStructuredErrorBody(response);
  const fallback = badRequestFallbackMessage(response, text);
  if (!body) {
    return new RequestPayloadTooLargeError(fallback);
  }
  const message = body.message ?? fallback;
  const code =
    body.code === 'REQUEST_TOO_LARGE' || body.code === 'TOO_MANY_FILES' ? body.code : undefined;
  const meta = body.meta;
  return new RequestPayloadTooLargeError(message, code, meta);
}
