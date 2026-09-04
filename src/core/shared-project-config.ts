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

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import { cloudRegionToUrl } from '@/core/server/sonarcloud-region.ts';
import type { CloudRegion } from '@/core/state/state.ts';

export interface SharedProjectConfigMapping {
  projectRoot: string;
  projectKey: string;
  serverUrl: string;
  organization?: string;
}

export type SharedProjectConfigEntryInput =
  | { projectKey: string; path: string; serverUrl: string }
  | { projectKey: string; path: string; region: CloudRegion; organization: string };

export interface SharedProjectConfigRepository {
  load(dir: string): Promise<SharedProjectConfigMapping | null>;
  set(dir: string, entry: SharedProjectConfigEntryInput): Promise<void>;
}

type SonarCloudProjectConfigEntryDto = {
  region: CloudRegion;
  organization: string;
  projectKey: string;
  path: string;
};

type SonarQubeServerProjectConfigEntryDto = {
  serverUrl: string;
  projectKey: string;
  path: string;
};

type SharedProjectConfigEntryDto =
  SonarCloudProjectConfigEntryDto | SonarQubeServerProjectConfigEntryDto;

/** File root — a container so other top-level fields can be added later without disturbing `project`. */
interface SharedProjectConfigFileDto {
  project?: unknown;
}

const VALID_CLOUD_REGIONS = new Set<CloudRegion>(['eu', 'us']);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCloudEntryDto(value: Record<string, unknown>): value is SonarCloudProjectConfigEntryDto {
  return (
    value.serverUrl === undefined &&
    VALID_CLOUD_REGIONS.has(value.region as CloudRegion) &&
    isNonEmptyString(value.organization)
  );
}

function isServerEntryDto(
  value: Record<string, unknown>,
): value is SonarQubeServerProjectConfigEntryDto {
  return (
    value.region === undefined &&
    value.organization === undefined &&
    isNonEmptyString(value.serverUrl)
  );
}

function isValidEntryDto(value: unknown): value is SharedProjectConfigEntryDto {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (!isNonEmptyString(record.projectKey) || !isNonEmptyString(record.path)) {
    return false;
  }
  return isCloudEntryDto(record) || isServerEntryDto(record);
}

export class SharedProjectConfigRepositoryImpl implements SharedProjectConfigRepository {
  async load(dir: string): Promise<SharedProjectConfigMapping | null> {
    const root = await this.readRawRoot(dir);
    return root === null ? null : this.resolveEntry(dir, root.project);
  }

  async set(dir: string, entry: SharedProjectConfigEntryInput): Promise<void> {
    const file: SharedProjectConfigFileDto = { project: entry };
    await writeFile(this.configPath(dir), JSON.stringify(file, null, 2), 'utf-8');
  }

  private configPath(dir: string): string {
    return join(dir, SHARED_PROJECT_CONFIG_FILE_NAME);
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
    if (!isValidEntryDto(raw)) {
      logger.debug(`Dropping invalid ${SHARED_PROJECT_CONFIG_FILE_NAME} entry in ${dir}`);
      return null;
    }

    if (isServerEntryDto(raw)) {
      return {
        projectRoot: canonicalizePath(join(dir, raw.path)),
        projectKey: raw.projectKey,
        serverUrl: raw.serverUrl,
        organization: undefined,
      };
    }

    return {
      projectRoot: canonicalizePath(join(dir, raw.path)),
      projectKey: raw.projectKey,
      serverUrl: cloudRegionToUrl(raw.region),
      organization: raw.organization,
    };
  }
}
