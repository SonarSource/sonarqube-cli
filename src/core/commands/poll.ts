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

import { setTimeout as delay } from 'node:timers/promises';

import { CommandFailedError, InvalidOptionError } from './command-error.ts';

export const DEFAULT_INSTALLATION_TIMEOUT_SECONDS = 300;
export const DEFAULT_ANALYSIS_TIMEOUT_SECONDS = 600;
export const MAX_WAIT_TIMEOUT_SECONDS = 86400;
export const CLOUD_POLL_INTERVAL_MS = 3000;

export function waitDeadline(timeout: number): number {
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_WAIT_TIMEOUT_SECONDS) {
    throw new InvalidOptionError(
      `--timeout must be an integer between 1 and ${MAX_WAIT_TIMEOUT_SECONDS} seconds.`,
    );
  }
  return Date.now() + timeout * 1000;
}

/** Poll sequentially: retries must observe the preceding attempt's server state. */
export async function pollUntil<T>(
  attempt: () => Promise<T | undefined>,
  deadline: number,
  timeoutMessage: string,
): Promise<T> {
  const value = await attempt();
  if (value !== undefined) return value;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new CommandFailedError(timeoutMessage);
  await delay(Math.min(CLOUD_POLL_INTERVAL_MS, remaining));
  return pollUntil(attempt, deadline, timeoutMessage);
}
