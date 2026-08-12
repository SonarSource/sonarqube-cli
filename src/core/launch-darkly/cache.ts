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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import logger from '@/core/observability/logger.ts';

import { FEATURE_FLAG_CACHE_TTL_MS, getLaunchDarklyDir } from './constants.ts';
import type { FeatureFlagIdentity } from './types.ts';

const CACHE_FILENAME = 'beta-flags-cache.json';

interface CacheEntry {
  fetchedAt: number;
  flags: Record<string, boolean>;
}

interface CacheFile {
  clientSideId: string;
  entries: Record<string, CacheEntry>;
}

function cacheFilePath(): string {
  return join(getLaunchDarklyDir(), CACHE_FILENAME);
}

export function identityCacheKey(identity: FeatureFlagIdentity): string {
  return [
    identity.connectionType,
    `user:${identity.userUuid ?? ''}`,
    `organization:${identity.organizationUuidV4 ?? ''}`,
    `installation:${identity.sqsInstallationId ?? ''}`,
  ].join('|');
}

function isCacheFile(value: unknown): value is CacheFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as { clientSideId?: unknown; entries?: unknown };
  return typeof record.entries === 'object' && record.entries !== null;
}

function readCacheFile(): CacheFile {
  const path = cacheFilePath();
  if (!existsSync(path)) {
    return { clientSideId: '', entries: {} };
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isCacheFile(parsed)) {
      return { clientSideId: '', entries: {} };
    }
    return {
      clientSideId: typeof parsed.clientSideId === 'string' ? parsed.clientSideId : '',
      entries: parsed.entries,
    };
  } catch (err) {
    logger.debug(`Failed to read feature-flag cache: ${(err as Error).message}`);
    return { clientSideId: '', entries: {} };
  }
}

function writeCacheFile(cache: CacheFile): void {
  try {
    const dir = getLaunchDarklyDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(cacheFilePath(), `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  } catch (err) {
    logger.debug(`Failed to write feature-flag cache: ${(err as Error).message}`);
  }
}

/**
 * Returns cached flag decisions when every requested key is present and fresh.
 * Expired or incomplete entries are ignored (never reused as a stale true).
 */
export function readFreshFlagDecisions(
  identity: FeatureFlagIdentity,
  flagKeys: readonly string[],
  clientSideId: string,
  nowMs: number = Date.now(),
): Record<string, boolean> | null {
  if (flagKeys.length === 0) {
    return {};
  }

  const cache = readCacheFile();
  if (cache.clientSideId !== clientSideId) {
    return null;
  }

  const entryKey = identityCacheKey(identity);
  const entry = Object.hasOwn(cache.entries, entryKey) ? cache.entries[entryKey] : undefined;
  if (entry === undefined || nowMs - entry.fetchedAt >= FEATURE_FLAG_CACHE_TTL_MS) {
    return null;
  }

  const decisions: Record<string, boolean> = {};
  for (const key of flagKeys) {
    if (!(key in entry.flags)) {
      return null;
    }
    decisions[key] = entry.flags[key];
  }
  return decisions;
}

/** Persists boolean decisions for the identity, replacing any previous entry. */
export function writeFlagDecisions(
  identity: FeatureFlagIdentity,
  flags: Record<string, boolean>,
  clientSideId: string,
  nowMs: number = Date.now(),
): void {
  const cache = readCacheFile();
  if (cache.clientSideId !== clientSideId) {
    cache.clientSideId = clientSideId;
    cache.entries = {};
  }
  cache.entries[identityCacheKey(identity)] = {
    fetchedAt: nowMs,
    flags: { ...flags },
  };
  writeCacheFile(cache);
}
