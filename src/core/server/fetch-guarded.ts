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

// Shared fetch utilities: request init builder and redirect guard.

import { buildFetchNetworkOptions } from '@/core/host/connectivity/network-config.ts';
import type { FetchNetworkOptions } from '@/core/host/connectivity/types.ts';

/**
 * `networkOptions` is required so a new call site cannot silently skip the resolved
 * proxy/TLS configuration. Pass `buildFetchNetworkOptions(url)` for the URL being fetched.
 * `body` stays positional but explicit: pass `undefined` for bodyless requests.
 */
export function buildFetchInit(
  method: string,
  headers: Record<string, string>,
  timeoutMs: number,
  body: string | undefined,
  networkOptions: FetchNetworkOptions,
): RequestInit {
  return { method, headers, body, signal: AbortSignal.timeout(timeoutMs), ...networkOptions };
}

// Fetch wrapper that prevents bearer token leakage via cross-origin redirects.

const HTTP_301_MOVED_PERMANENTLY = 301;
const HTTP_302_FOUND = 302;
const HTTP_303_SEE_OTHER = 303;
const HTTP_307_TEMPORARY_REDIRECT = 307;
const HTTP_308_PERMANENT_REDIRECT = 308;

const REDIRECT_STATUSES = new Set([
  HTTP_301_MOVED_PERMANENTLY,
  HTTP_302_FOUND,
  HTTP_303_SEE_OTHER,
  HTTP_307_TEMPORARY_REDIRECT,
  HTTP_308_PERMANENT_REDIRECT,
]);
const MAX_REDIRECTS = 5;

/**
 * Fetch wrapper that prevents bearer token leakage via cross-origin redirects.
 *
 * Uses redirect: 'manual' to intercept every 3xx before the runtime follows it.
 * Actual redirect statuses (301, 302, 303, 307, 308) are handled explicitly:
 * - HTTP→HTTPS upgrades on the same hostname and port are allowed
 * - Same-origin redirects are followed transparently
 * - Cross-origin redirects throw so the Authorization header is never forwarded
 * Non-redirect 3xx (e.g. 304 Not Modified) are returned as-is.
 */
export async function fetchGuarded(url: string, init: RequestInit): Promise<Response> {
  let currentUrl = url;
  let currentInit = init;

  for (let redirectCount = 0; ; redirectCount++) {
    const response = await fetch(currentUrl, { ...currentInit, redirect: 'manual' });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      return response;
    }

    if (redirectCount >= MAX_REDIRECTS) {
      throw new Error('too many redirects');
    }

    const redirectUrl = new URL(location, currentUrl);
    assertAllowedRedirect(currentUrl, redirectUrl);

    // 301/302/303 downgrade POST → GET, drop the body, and strip Content-Type.
    // 307/308 preserve method, body, and headers unchanged.
    const preservesMethod =
      response.status === HTTP_307_TEMPORARY_REDIRECT ||
      response.status === HTTP_308_PERMANENT_REDIRECT;

    const schemeChanged = redirectUrl.protocol !== new URL(currentUrl).protocol;
    currentUrl = redirectUrl.toString();
    if (!preservesMethod) {
      currentInit = {
        ...currentInit,
        method: 'GET',
        body: undefined,
        headers: withoutContentType(currentInit.headers),
      };
    }
    if (schemeChanged) {
      // Scheme changed (HTTP→HTTPS): stale proxy/tls options from the original
      // protocol are no longer correct. Strip them and recompute for the new URL.
      const { proxy: _p, tls: _t, ...rest } = currentInit as RequestInit & FetchNetworkOptions;
      currentInit = { ...rest, ...buildFetchNetworkOptions(currentUrl) };
    }
  }
}

function assertAllowedRedirect(fromUrl: string, redirectUrl: URL): void {
  const from = new URL(fromUrl);
  const isSameOrigin = redirectUrl.origin === from.origin;
  const isHttpsUpgrade =
    redirectUrl.hostname === from.hostname &&
    redirectUrl.port === from.port &&
    from.protocol === 'http:' &&
    redirectUrl.protocol === 'https:';

  if (!isSameOrigin && !isHttpsUpgrade) {
    throw new Error(
      `cross-origin redirect to ${redirectUrl.origin} rejected — bearer token not forwarded`,
    );
  }
}

function toPairs(src: NonNullable<RequestInit['headers']>): [string, string][] {
  if (src instanceof Headers) return [...src.entries()];
  if (Array.isArray(src)) return src.map(([k, v]): [string, string] => [k, v]);
  return Object.entries(src).map(([k, v]): [string, string] => [
    k,
    typeof v === 'string' ? v : v.join(', '),
  ]);
}

function withoutContentType(src: RequestInit['headers']): Record<string, string> {
  const pairs = src ? toPairs(src) : [];
  return Object.fromEntries(pairs.filter(([key]) => key.toLowerCase() !== 'content-type'));
}
