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

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'bun:test';

import { flushTimings, timeAsync, timeSync } from '../../_common/ci-timing.js';

const previous = process.env.CI_TEST_TIMINGS_DIR;
const dir = mkdtempSync(join(tmpdir(), 'ci-timing-'));
afterEach(() => {
  if (previous === undefined) delete process.env.CI_TEST_TIMINGS_DIR;
  else process.env.CI_TEST_TIMINGS_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

it('is opt-in and preserves results and failures while aggregating only counts and durations', async () => {
  delete process.env.CI_TEST_TIMINGS_DIR;
  expect(timeSync('git', () => 'unchanged')).toBe('unchanged');
  flushTimings();
  expect(readdirSync(dir)).toEqual([]);
  process.env.CI_TEST_TIMINGS_DIR = dir;
  expect(timeSync('git', () => 'argument-must-not-be-recorded')).toBe(
    'argument-must-not-be-recorded',
  );
  const failure = new Error('failure-must-not-be-recorded');
  expect(() =>
    timeSync('git', () => {
      throw failure;
    }),
  ).toThrow(failure);
  const rejected = await timeAsync('cleanup', () => Promise.reject(failure)).catch(
    (error: unknown) => error,
  );
  expect(rejected).toBe(failure);
  flushTimings();
  flushTimings();
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  const data = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8'));
  expect(data).toEqual({
    git: { count: 2, durationMs: expect.any(Number) },
    cleanup: { count: 1, durationMs: expect.any(Number) },
  });
});
