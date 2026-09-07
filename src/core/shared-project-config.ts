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

import { statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import { canonicalizePath, isAncestorOrSelf } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import { cloudRegionToUrl } from '@/core/server/sonarcloud-region.ts';
import type { CloudRegion } from '@/core/state/state.ts';

export interface SharedProjectConfigMapping {
  projectRoot: string;
  projectKey: string;
  serverUrl: string;
  organization?: string;
}

/**
 * The wire shape of a `project` entry — identical whether it's about to be written by
 * `set()` or was just read back and validated by `load()`, since `set()` serializes it
 * verbatim as JSON. One type serves both directions instead of a write-side and a
 * read-side DTO declaring the same two shapes twice.
 */
export type SonarCloudProjectConfigEntry = {
  projectKey: string;
  path: string;
  region: CloudRegion;
  organization: string;
};

export type SonarQubeServerProjectConfigEntry = {
  projectKey: string;
  path: string;
  serverUrl: string;
};

export type SharedProjectConfigEntry =
  SonarCloudProjectConfigEntry | SonarQubeServerProjectConfigEntry;

export interface SharedProjectConfigRepository {
  load(dir: string): Promise<SharedProjectConfigMapping | null>;
  set(dir: string, entry: SharedProjectConfigEntry): Promise<void>;
}

/** File root — a container so other top-level fields can be added later without disturbing `project`. */
interface SharedProjectConfigFileDto {
  project?: unknown;
}

const VALID_CLOUD_REGIONS = new Set<CloudRegion>(['eu', 'us']);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCloudEntry(value: Record<string, unknown>): value is SonarCloudProjectConfigEntry {
  return (
    value.serverUrl === undefined &&
    VALID_CLOUD_REGIONS.has(value.region as CloudRegion) &&
    isNonEmptyString(value.organization)
  );
}

function isServerEntry(value: Record<string, unknown>): value is SonarQubeServerProjectConfigEntry {
  return (
    value.region === undefined &&
    value.organization === undefined &&
    isNonEmptyString(value.serverUrl)
  );
}

function isValidEntry(value: unknown): value is SharedProjectConfigEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (!isNonEmptyString(record.projectKey) || !isNonEmptyString(record.path)) {
    return false;
  }
  return isCloudEntry(record) || isServerEntry(record);
}

/**
 * A committed config must not steer writes/mounts outside the directory holding it.
 * Requires the resolved path to actually exist: `canonicalizePath()` falls back to a
 * purely lexical `resolve()` for a path that doesn't exist yet, which would leave an
 * existing symlinked intermediate directory unresolved and able to escape `dir`
 * undetected. Requiring existence sidesteps that gap entirely — a project root that
 * isn't there is invalid regardless — and there is no legitimate case where the
 * project root should point at a directory that doesn't exist.
 */
export function resolveContainedPath(dir: string, rawPath: string): string | null {
  if (isAbsolute(rawPath)) {
    return null;
  }
  const canonicalDir = canonicalizePath(dir);
  const lexical = join(canonicalDir, rawPath);
  // Must be a directory: the result is later joined with file names and used as a write/mount target.
  if (!statSync(lexical, { throwIfNoEntry: false })?.isDirectory()) {
    return null;
  }
  const resolved = canonicalizePath(lexical);
  return isAncestorOrSelf(canonicalDir, resolved) ? resolved : null;
}

export class SharedProjectConfigRepositoryImpl implements SharedProjectConfigRepository {
  async load(dir: string): Promise<SharedProjectConfigMapping | null> {
    const root = await this.readRawRoot(dir);
    return root === null ? null : this.resolveEntry(dir, root.project);
  }

  async set(dir: string, entry: SharedProjectConfigEntry): Promise<void> {
    const existing = await this.readExistingRootForWrite(dir);
    const file: SharedProjectConfigFileDto = { ...existing, project: entry };
    await writeFile(this.configPath(dir), JSON.stringify(file, null, 2), 'utf-8');
  }

  private configPath(dir: string): string {
    return join(dir, SHARED_PROJECT_CONFIG_FILE_NAME);
  }

  /**
   * Read the existing file to merge into, so `set()` preserves any other top-level
   * fields already there. Unlike `readRawRoot()` (used by `load()`, which treats an
   * unreadable/invalid file as "no mapping" and moves on), a write must not silently
   * clobber content it failed to read: only a genuinely absent file is safe to treat
   * as empty — any other read or parse failure aborts the write instead.
   */
  private async readExistingRootForWrite(dir: string): Promise<SharedProjectConfigFileDto> {
    let content: string;
    try {
      content = await readFile(this.configPath(dir), 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw error;
    }

    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${this.configPath(dir)} does not contain a JSON object`);
    }
    return parsed;
  }

  private async readRawRoot(dir: string): Promise<SharedProjectConfigFileDto | null> {
    let content: string;
    try {
      content = await readFile(this.configPath(dir), 'utf-8');
    } catch {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(content);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed
        : null;
    } catch (error) {
      logger.debug(`Failed to parse ${this.configPath(dir)}: ${(error as Error).message}`);
      return null;
    }
  }

  private resolveEntry(dir: string, raw: unknown): SharedProjectConfigMapping | null {
    if (!isValidEntry(raw)) {
      logger.debug(`Dropping invalid ${SHARED_PROJECT_CONFIG_FILE_NAME} entry in ${dir}`);
      return null;
    }

    const projectRoot = resolveContainedPath(dir, raw.path);
    if (projectRoot === null) {
      logger.debug(
        `Dropping ${SHARED_PROJECT_CONFIG_FILE_NAME} entry in ${dir}: "path" does not exist or escapes it`,
      );
      return null;
    }

    if (isServerEntry(raw)) {
      return {
        projectRoot,
        projectKey: raw.projectKey,
        serverUrl: raw.serverUrl,
        organization: undefined,
      };
    }

    return {
      projectRoot,
      projectKey: raw.projectKey,
      serverUrl: cloudRegionToUrl(raw.region),
      organization: raw.organization,
    };
  }
}

/** Shared singleton so `project-info.ts` and `link/index.ts` mock the same instance in tests via `spyOn`. */
export const sharedProjectConfigRepository: SharedProjectConfigRepository =
  new SharedProjectConfigRepositoryImpl();
