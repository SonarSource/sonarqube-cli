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

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Metric =
  | 'git'
  | 'binary-copy'
  | 'cli'
  | 'cleanup'
  | 'coverage-read'
  | 'coverage-merge'
  | 'coverage-render';
const totals: Partial<Record<Metric, { count: number; durationMs: number }>> = {};

export function recordTiming(metric: Metric, durationMs: number): void {
  if (!process.env.CI_TEST_TIMINGS_DIR) return;
  const total = (totals[metric] ??= { count: 0, durationMs: 0 });
  total.count++;
  total.durationMs += durationMs;
}

export function timeSync<T>(metric: Metric, action: () => T): T {
  if (!process.env.CI_TEST_TIMINGS_DIR) return action();
  const started = performance.now();
  try {
    return action();
  } finally {
    recordTiming(metric, performance.now() - started);
  }
}

export async function timeAsync<T>(metric: Metric, action: () => Promise<T>): Promise<T> {
  if (!process.env.CI_TEST_TIMINGS_DIR) return action();
  const started = performance.now();
  try {
    return await action();
  } finally {
    recordTiming(metric, performance.now() - started);
  }
}

export function flushTimings(): void {
  const dir = process.env.CI_TEST_TIMINGS_DIR;
  if (!dir || Object.keys(totals).length === 0) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.pid}-${crypto.randomUUID()}.json`), JSON.stringify(totals));
  for (const metric of Object.keys(totals) as Metric[]) delete totals[metric];
}
