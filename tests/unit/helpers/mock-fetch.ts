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

// Shared fetch mock helpers for unit tests of API clients.

import { spyOn } from 'bun:test';

export interface FakeResponseOpts {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
}

export function fakeResponse(body: unknown, opts: FakeResponseOpts = {}): Response {
  const status = opts.status ?? 200;
  const ok = opts.ok ?? status < 400;
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: new Headers(opts.headers ?? {}),
  } as Response;
}

export function mockFetch(body: unknown, opts: FakeResponseOpts = {}): ReturnType<typeof spyOn> {
  return spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(body, opts));
}

export function mockFetchSeq(...responses: Response[]): ReturnType<typeof spyOn> {
  const spy = spyOn(globalThis, 'fetch');
  for (const r of responses) spy.mockResolvedValueOnce(r);
  return spy;
}

export function lastFetchUrl(spy: ReturnType<typeof spyOn>): string {
  const calls = spy.mock.calls;
  return (calls[calls.length - 1][0] as string | URL).toString();
}

export function nthFetchUrl(spy: ReturnType<typeof spyOn>, n: number): string {
  return (spy.mock.calls[n][0] as string | URL).toString();
}

export function lastFetchInit(spy: ReturnType<typeof spyOn>): RequestInit {
  const calls = spy.mock.calls;
  return calls[calls.length - 1][1] as RequestInit;
}
