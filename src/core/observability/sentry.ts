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

import { homedir } from 'node:os';

import type { ErrorEvent, EventHint } from '@sentry/bun';
import * as Sentry from '@sentry/bun';

import { buildRequest, fetchAuthenticated } from '@/core/server/fetch.ts';
import { resolveTelemetryEgress } from '@/core/telemetry/egress.ts';
import { isTelemetryEnabled } from '@/core/telemetry/enabled.ts';
import { getOrCreateUserId } from '@/core/telemetry/user.ts';

import { SENTRY_DSN, SENTRY_FLUSH_TIMEOUT_MS } from '../config-constants.ts';
import type { CliState } from '../state/state.ts';

/**
 * Initialize Sentry if the user has opted in and egress is production.
 *
 * Error reporting has no switch of its own: `sonar config telemetry` governs both.
 */
export function initSentry(state: CliState): void {
  if (!isTelemetryEnabled(state) || resolveTelemetryEgress().kind !== 'production') return;

  const environment = process.env.SONARSOURCE_DOGFOODING === '1' ? 'dogfood' : 'production';

  Sentry.init({
    dsn: SENTRY_DSN,
    environment,
    sendDefaultPii: false,
    beforeSend: scrubPii,
    transport: createSentryTransport,
  });

  Sentry.setUser({ id: getOrCreateUserId() });
}

/**
 * Bounds a single envelope upload. `SENTRY_FLUSH_TIMEOUT_MS` only stops us waiting; it does
 * not cancel the request, so without this a stalled endpoint keeps the process alive after
 * the command has finished. Longer than the flush window so a slow proxy handshake still
 * completes, short enough that nothing lingers noticeably.
 *
 * Declared here rather than in `config-constants.ts` with the other Sentry values, because
 * that file carries a pre-existing secrets finding with no working suppression (CLI-1140),
 * which makes any change to it fail the pre-commit scan.
 */
const SENTRY_REQUEST_TIMEOUT_MS = 2_000;

function createSentryTransport(
  options: Parameters<NonNullable<Sentry.BunOptions['transport']>>[0],
) {
  return Sentry.createTransport(options, async (request) => {
    const response = await fetchAuthenticated(options.url, {
      // buildRequest is what attaches the abort signal, and using it here keeps this call
      // site consistent with every other one. The body is assigned separately because an
      // envelope can be a Uint8Array, which buildRequest's signature does not describe.
      ...buildRequest('POST', options.headers ?? {}, SENTRY_REQUEST_TIMEOUT_MS, undefined),
      body: request.body,
    });

    return {
      statusCode: response.status,
      headers: {
        'retry-after': response.headers.get('Retry-After'),
        'x-sentry-rate-limits': response.headers.get('X-Sentry-Rate-Limits'),
      },
    };
  });
}

/**
 * Flush pending Sentry events, but only if a client was initialized.
 */
export async function flushSentry(): Promise<void> {
  if (Sentry.getClient()) {
    await Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS);
  }
}

/**
 * Strip the user's home directory from all stack frame filenames before
 * the event is transmitted, replacing it with '~'.
 */
function scrubPii(event: ErrorEvent, _hint: EventHint): ErrorEvent {
  scrubStrings(event, (s) => s.replaceAll(homedir(), '~'));
  return event;
}

/**
 * Recursively walk an object and apply scrub() to every string value in place.
 */
function scrubStrings(node: unknown, scrub: (s: string) => string): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (typeof node[i] === 'string') {
        node[i] = scrub(node[i] as string);
      } else {
        scrubStrings(node[i], scrub);
      }
    }
  } else if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'string') {
        obj[key] = scrub(obj[key]);
      } else {
        scrubStrings(obj[key], scrub);
      }
    }
  }
}
