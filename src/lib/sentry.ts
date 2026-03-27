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

import * as Sentry from '@sentry/bun';
import type { ErrorEvent, EventHint } from '@sentry/bun';
import { homedir } from 'node:os';
import { SENTRY_DSN } from './config-constants.js';
import { getOrCreateUserId } from '../telemetry/user.js';
import type { CliState } from './state.js';

/**
 * Initialize Sentry if telemetry is enabled.
 * Must be called before any other code that may throw.
 */
export function initSentry(state: CliState): void {
  if (!state.telemetry.enabled) return;

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
