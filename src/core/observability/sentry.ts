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
  });

  Sentry.setUser({ id: getOrCreateUserId() });
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
