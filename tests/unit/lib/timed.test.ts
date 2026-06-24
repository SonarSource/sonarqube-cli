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

import { describe, expect, it } from 'bun:test';

import { timed } from '../../../src/lib/timed.js';

describe('timed()', () => {
  it('returns the resolved value and a non-negative durationMs', async () => {
    const { result, durationMs } = await timed(() => Promise.resolve(42));
    expect(result).toBe(42);
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it('durationMs reflects actual elapsed time', async () => {
    const SLEEP_MS = 50;
    const { durationMs } = await timed(() => Bun.sleep(SLEEP_MS));
    // Floor catches implementations that always return 0 or measure only sync
    // overhead. No upper bound: wall-clock time is unbounded under CI load.
    expect(durationMs).toBeGreaterThanOrEqual(SLEEP_MS);
  });

  it('propagates errors thrown by the wrapped function', async () => {
    const boom = new Error('boom');
    let caught: unknown;
    try {
      await timed(() => Promise.reject(boom));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
  });
});
