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

// One process runs one invocation, so a process-wide total is the invocation's total.
let totalMs = 0;

/**
 * Counts the time `wait` takes as time spent waiting on the user. A wait that prompts gives its
 * prompts `console.unmeasured()`, so that time is not counted twice.
 */
export async function measureUserWait<T>(wait: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await wait();
  } finally {
    totalMs += performance.now() - startedAt;
  }
}

/** Time spent on prompts and browser steps so far, in whole milliseconds. */
export function userWaitMs(): number {
  return Math.round(totalMs);
}

export function resetUserWaitForTests(): void {
  totalMs = 0;
}
