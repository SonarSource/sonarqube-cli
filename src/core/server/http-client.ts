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

import { NetworkConfigError } from '@/core/errors.ts';
import { errAsync, okAsync, ResultAsync } from '@/core/result.ts';
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_PAYLOAD_TOO_LARGE,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
} from '@/core/server/http-constants.ts';
import type { Console } from '@/core/ui/console.ts';

import { version as VERSION } from '../../../package.json';
import logger from '../observability/logger.ts';
import {
  AccessDeniedError,
  BadRequestError,
  ForbiddenApiError,
  type HttpClientError,
  RateLimitError,
  RequestPayloadTooLargeError,
  type RequestPayloadTooLargeMeta,
  ServerError,
  ServiceUnavailableError,
  TransportError,
  UnexpectedApiError,
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
  private readonly serverURL: string;
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
  ): Promise<HttpClientError | undefined> {
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

    // Any other 5xx (500/502/504) is server-side and critical, regardless of method.
    const isServerFailure = response.status >= HTTP_STATUS_INTERNAL_SERVER_ERROR;
    const buildError = (message: string): HttpClientError =>
      isServerFailure
        ? new ServerError(response.status, message)
        : new UnexpectedApiError(response.status, message);

    if (method === 'GET') {
      if (response.status === HTTP_STATUS_FORBIDDEN || response.status === HTTP_STATUS_NOT_FOUND) {
        return new AccessDeniedError(response.status);
      }
      const errorText = await response.text();
      logger.debug(`SonarQube GET ${response.url} failed: ${response.status} ${errorText}`);
      return buildError(`SonarQube API error: ${response.status} ${response.statusText}`);
    }

    const errorText = await response.text();
    return buildError(
      `SonarQube API error: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  /**
   * genericRequest is a generic method to make arbitrary HTTP requests.
   * It should ONLY be used for the `sonar api` command.
   */
  genericRequest(
    method: HttpMethod,
    endpoint: string,
    console: Console,
    data?: string,
    contentType: 'json' | 'form' = 'json',
    debug = false,
  ): ResultAsync<string, HttpClientError> {
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
      console.print(`request method: ${method}`, 'stderr');
      console.print(`request url: ${url}`, 'stderr');
      console.print(
        `request headers: ${JSON.stringify(redactSensitiveHeaders(headers))}`,
        'stderr',
      );
      console.print(`request body: ${requestBody}`, 'stderr');
    }

    return ResultAsync.fromPromise(
      fetchAuthenticated(url, buildRequest(method, headers, timeout, requestBody)),
      toError,
    ).andThen((response) => {
      if (debug) {
        console.print(`response status: ${response.status}`, 'stderr');
        console.print(`response headers: ${JSON.stringify(response.headers)}`, 'stderr');
      }
      return this.toStatusCheckedResult(response, method, () => response.text());
    });
  }

  /**
   * Make GET request to SonarQube API
   */
  get<T>(
    endpoint: string,
    params?: QueryParams,
    baseUrl?: string,
  ): ResultAsync<T, HttpClientError> {
    return this.getSafe<T>(endpoint, params, baseUrl).andThen((result) => this.toGetResult(result));
  }

  /**
   * Like `get`, but resolves to `Ok(null)` instead of an error when the server responds
   * 404. Every other non-2xx status still yields its normal typed error.
   */
  getOrNotFound<T>(
    endpoint: string,
    params?: QueryParams,
    baseUrl?: string,
  ): ResultAsync<T | null, HttpClientError> {
    return this.getSafe<T>(endpoint, params, baseUrl).andThen((result) => {
      if (result.response.status === HTTP_STATUS_NOT_FOUND) {
        return okAsync(null);
      }
      return this.toGetResult(result);
    });
  }

  private toGetResult<T>(result: SafeGetResult<T>): ResultAsync<T, HttpClientError> {
    return ResultAsync.fromPromise(this.buildStatusError(result.response, 'GET'), toError).andThen(
      (error) => {
        if (error) {
          return errAsync(error);
        }
        if (result.value === undefined) {
          return errAsync(
            new UnexpectedApiError(
              result.response.status,
              'SonarQube API error: empty response body',
            ),
          );
        }
        return okAsync(result.value);
      },
    );
  }

  /**
   * Resolves to `{ response, value }` and never rejects. Only the *status* is left
   * uninterpreted (`value` is `undefined` on a non-2xx response) for the handful of
   * callers (`getOrNotFound`, telemetry identity/project-uuid lookups) that need to branch
   * on the status themselves instead of getting a single typed error for "not 2xx". A
   * transport failure (DNS/TLS failure, connection refused, timeout) becomes
   * `TransportError`; a body-parse failure on an otherwise-2xx response becomes
   * `UnexpectedApiError` instead, since the server did answer. Same split as
   * `toStatusCheckedResult` below, so a malformed body classifies the same way regardless
   * of which method reads it.
   */
  getSafe<TValue>(
    endpoint: string,
    params?: QueryParams,
    baseUrl?: string,
    timeoutMs: number = GET_REQUEST_TIMEOUT_MS,
  ): ResultAsync<SafeGetResult<TValue>, HttpClientError> {
    return ResultAsync.fromPromise(
      (async (): Promise<Response> => {
        const url = new URL(`${baseUrl ?? this.serverURL}${endpoint}`);
        if (params) {
          Object.entries(params).forEach(([key, value]) => {
            url.searchParams.append(key, String(value));
          });
        }
        return fetchAuthenticated(
          url.toString(),
          buildRequest('GET', this.commonHeaders(), timeoutMs, undefined),
        );
      })(),
      toError,
    ).andThen((response) =>
      ResultAsync.fromPromise(
        (async (): Promise<TValue | undefined> =>
          response.ok ? ((await response.json()) as TValue) : undefined)(),
        (err) =>
          new UnexpectedApiError(response.status, err instanceof Error ? err.message : String(err)),
      ).map((value) => ({ response, value })),
    );
  }

  /**
   * Make POST request to SonarQube API using Bearer token
   */
  post<T>(
    endpoint: string,
    body: unknown,
    baseUrl?: string,
    extraHeaders?: Record<string, string>,
  ): ResultAsync<T, HttpClientError> {
    const url = `${baseUrl ?? this.serverURL}${endpoint}`;
    const headers = { ...this.commonHeaders('json'), ...extraHeaders };

    return ResultAsync.fromPromise(
      fetchAuthenticated(
        url,
        buildRequest('POST', headers, POST_REQUEST_TIMEOUT_MS, JSON.stringify(body)),
      ),
      toError,
    ).andThen((response) =>
      this.toStatusCheckedResult(response, 'POST', () => response.json() as Promise<T>),
    );
  }

  /**
   * Generic helper to POST a form-encoded body to a SonarQube endpoint using the
   * configured Bearer token. Resolves to `Err` (never throws) on a non-2xx response or a
   * transport failure, so callers can handle failures (e.g. best-effort logout). The
   * response body is discarded.
   */
  postForm(
    endpoint: string,
    params: Record<string, string>,
    timeoutMs: number = POST_REQUEST_TIMEOUT_MS,
  ): ResultAsync<void, HttpClientError> {
    const url = `${this.serverURL}${endpoint}`;

    return ResultAsync.fromPromise(
      fetchAuthenticated(
        url,
        buildRequest(
          'POST',
          this.commonHeaders('form'),
          timeoutMs,
          new URLSearchParams(params).toString(),
        ),
      ),
      toError,
    ).andThen((response) =>
      this.toStatusCheckedResult(response, 'POST', () => Promise.resolve(undefined)),
    );
  }

  /**
   * Like `postForm`, but parses and returns the JSON response body instead of
   * discarding it. Used for legacy endpoints that are
   * form-encoded on the request side but return a JSON body.
   */
  postFormJson<T>(
    endpoint: string,
    params: Record<string, string>,
  ): ResultAsync<T, HttpClientError> {
    const url = `${this.serverURL}${endpoint}`;

    return ResultAsync.fromPromise(
      fetchAuthenticated(
        url,
        buildRequest(
          'POST',
          this.commonHeaders('form'),
          POST_REQUEST_TIMEOUT_MS,
          new URLSearchParams(params).toString(),
        ),
      ),
      toError,
    ).andThen((response) =>
      this.toStatusCheckedResult(response, 'POST', () => response.json() as Promise<T>),
    );
  }

  /**
   * Shared tail for every method built on a single request/response round trip: check
   * the response status, and only read the body when the status was OK. `readBody` must
   * itself never reject on a well-formed response. A rejection there (e.g. malformed
   * JSON) is reported as `UnexpectedApiError` rather than `TransportError`, since the
   * server did answer.
   */
  private toStatusCheckedResult<T>(
    response: Response,
    method: HttpMethod,
    readBody: () => Promise<T>,
  ): ResultAsync<T, HttpClientError> {
    return ResultAsync.fromPromise(this.buildStatusError(response, method), toError).andThen(
      (error) => {
        if (error) {
          return errAsync(error);
        }
        return ResultAsync.fromPromise(
          readBody(),
          (err) =>
            new UnexpectedApiError(
              response.status,
              err instanceof Error ? err.message : String(err),
            ),
        );
      },
    );
  }
}

/**
 * Wraps whatever escaped the request itself as a `TransportError`: a throw from
 * `fetchAuthenticated` (DNS/TLS/proxy failure, connection refused, timeout, abort), before
 * any response was received. A body-parse failure on a response that did arrive is a
 * separate case, classified as `UnexpectedApiError` instead; see `getSafe` and
 * `toStatusCheckedResult`, the only two places that read a body.
 *
 * `NetworkConfigError` is passed through unwrapped: it already describes the failure
 * precisely and is matched by name elsewhere (e.g. `remediationHintFor`), so re-wrapping
 * it would drop its remediation hint. It stays classified as critical in
 * `isCriticalFailure` regardless.
 */
function toError(err: unknown): HttpClientError {
  if (err instanceof NetworkConfigError) {
    return err;
  }
  return err instanceof Error
    ? new TransportError(err.message, { cause: err })
    : new TransportError(String(err));
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
