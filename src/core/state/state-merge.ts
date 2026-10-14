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
import { isDeepStrictEqual } from 'node:util';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function entryKey(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.id === 'string') return `id:${value.id}`;
  if (typeof value.featureId === 'string') {
    return `feature:${value.featureId}:${typeof value.targetRoot === 'string' ? value.targetRoot : ''}`;
  }
  if (typeof value.targetRoot === 'string' && typeof value.projectKey === 'string') {
    return `mapping:${value.targetRoot}:${value.projectKey}`;
  }
  return null;
}

function keyed(values: unknown[]): Map<string, unknown> | null {
  const result = new Map<string, unknown>();
  for (const value of values) {
    const key = entryKey(value);
    if (key === null || result.has(key)) return null;
    result.set(key, value);
  }
  return result;
}

function mergeArray(
  base: unknown[],
  changed: unknown[],
  current: unknown[],
  path: string,
): unknown[] {
  const baseline = keyed(base);
  const desired = keyed(changed);
  const latest = keyed(current);
  if (baseline === null || desired === null || latest === null) {
    throw new Error(`Concurrent state change conflicts at ${path}`);
  }

  const result = new Map(latest);
  for (const [key, oldValue] of baseline) {
    if (!desired.has(key)) {
      if (!isDeepStrictEqual(latest.get(key), oldValue)) {
        throw new Error(`Concurrent state change conflicts at ${path}.${key}`);
      }
      result.delete(key);
    }
  }
  for (const [key, newValue] of desired) {
    const oldValue = baseline.get(key);
    if (isDeepStrictEqual(newValue, oldValue)) continue;
    if (
      oldValue === undefined &&
      latest.has(key) &&
      !isDeepStrictEqual(latest.get(key), newValue)
    ) {
      throw new Error(`Concurrent state change conflicts at ${path}.${key}`);
    }
    result.set(key, mergeStateValue(oldValue, newValue, latest.get(key), `${path}.${key}`));
  }
  return [...result.values()];
}

function mergeRecord(
  base: Record<string, unknown>,
  changed: Record<string, unknown>,
  current: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const result = { ...current };
  for (const key of new Set([...Object.keys(base), ...Object.keys(changed)])) {
    if (isDeepStrictEqual(base[key], changed[key])) continue;
    const merged = mergeStateValue(base[key], changed[key], current[key], `${path}.${key}`);
    if (merged === undefined) Reflect.deleteProperty(result, key);
    else result[key] = merged;
  }
  return result;
}

export function mergeStateValue(
  base: unknown,
  changed: unknown,
  current: unknown,
  path = 'state',
): unknown {
  if (isDeepStrictEqual(base, changed)) return current;
  if (isDeepStrictEqual(base, current) || isDeepStrictEqual(changed, current)) return changed;

  if (base === undefined && Array.isArray(changed) && Array.isArray(current)) {
    return mergeArray([], changed, current, path);
  }
  if (base === undefined && isRecord(changed) && isRecord(current)) {
    return mergeRecord({}, changed, current, path);
  }
  if (Array.isArray(base) && Array.isArray(changed) && Array.isArray(current)) {
    return mergeArray(base, changed, current, path);
  }
  if (isRecord(base) && isRecord(changed) && isRecord(current)) {
    return mergeRecord(base, changed, current, path);
  }
  throw new Error(`Concurrent state change conflicts at ${path}`);
}
