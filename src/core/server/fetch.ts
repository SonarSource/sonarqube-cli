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

// The only place in the CLI allowed to call the runtime `fetch`. An ESLint rule forbids
// it anywhere else, so every outbound HTTP request goes through one of the two exported
// wrappers and the resolved proxy/TLS configuration is always applied.
//
// Callers pick by whether the request carries a credential, not by how it behaves:
// `fetchAuthenticated` for a request whose headers include a token, `fetchAnonymous`
// otherwise. That is the only decision a call site has to make; the redirect handling
// each one needs follows from it.

import { buildFetchNetworkOptions } from '@/core/host/connectivity/network-config.ts';
import type { FetchNetworkOptions } from '@/core/host/connectivity/types.ts';

/**
 * Builds a `RequestInit` for the wrappers below. It deliberately carries no
 * proxy/TLS options: those are owned by the wrappers, not by call sites.
 * `body` stays positional but explicit: pass `undefined` for bodyless requests.
 */
export function buildRequest(
  method: string,
  headers: Record<string, string>,
  timeoutMs: number,
  body: string | undefined,
): RequestInit {
  return { method, headers, body, signal: AbortSignal.timeout(timeoutMs) };
}

/**
 * Applies the resolved proxy/TLS configuration for `url` and performs the request.
 * Options are spread last, and any proxy/TLS keys on `init` are dropped, so a call
 * site can neither skip nor override the configuration.
 *
 * Throws `NetworkConfigError` when the configuration itself is unusable, rather
 * than silently falling back to a direct connection.
 */
async function sendRequest(url: string, init: RequestInit): Promise<Response> {
  const { proxy: _proxy, tls: _tls, ...rest } = init as RequestInit & Partial<FetchNetworkOptions>;
  return fetch(url, { ...rest, ...buildFetchNetworkOptions(url) });
}

const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'private-token', 'x-api-key']);

/**
 * Fetch for a request that carries no credential. Redirects are followed the way the
 * runtime normally would, since there is no token to leak.
 *
 * The caller supplies the headers, so nothing here can tell a credentialed request
 * apart on intent alone: a credential header is rejected outright rather than left to
 * review. Use `fetchAuthenticated` for those.
 */
export async function fetchAnonymous(url: string, init: RequestInit = {}): Promise<Response> {
  assertNoCredentialHeaders(init.headers);
  return sendRequest(url, init);
}

function assertNoCredentialHeaders(headers: RequestInit['headers']): void {
  const credential = (headers ? toPairs(headers) : []).find(([key]) =>
    CREDENTIAL_HEADERS.has(key.toLowerCase()),
  );
  if (credential) {
    throw new Error(
      `fetchAnonymous does not accept the credential header "${credential[0]}" — use fetchAuthenticated, which blocks cross-origin redirects`,
    );
  }
}

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
 * Fetch for a request whose headers carry a credential. It does not add the credential
 * itself; it makes carrying one safe by preventing token leakage through a redirect.
 *
 * Uses redirect: 'manual' to intercept every 3xx before the runtime follows it.
 * Actual redirect statuses (301, 302, 303, 307, 308) are handled explicitly:
 * - HTTP→HTTPS upgrades on the same hostname and port are allowed
 * - Same-origin redirects are followed transparently
 * - Cross-origin redirects throw so the Authorization header is never forwarded
 * Non-redirect 3xx (e.g. 304 Not Modified) are returned as-is.
 *
 * Network options are resolved per hop, so a followed HTTP→HTTPS upgrade never
 * reuses the proxy/TLS options computed for the original scheme.
 */
export async function fetchAuthenticated(url: string, init: RequestInit): Promise<Response> {
  let currentUrl = url;
  let currentInit = init;

  for (let redirectCount = 0; ; redirectCount++) {
    const response = await sendRequest(currentUrl, {
      ...currentInit,
      redirect: 'manual',
    });

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

    currentUrl = redirectUrl.toString();
    if (!preservesMethod) {
      currentInit = {
        ...currentInit,
        method: 'GET',
        body: undefined,
        headers: withoutContentType(currentInit.headers),
      };
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
