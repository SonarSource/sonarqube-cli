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
import { isAbsolute, join, relative, sep } from 'node:path';

import { CommandFailedError } from '@/core/commands/command-error.ts';
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

export type CustomCloudProjectConfigEntry = {
  projectKey: string;
  path: string;
  serverUrl: string;
  organization: string;
};

export type SharedProjectConfigEntry =
  SonarCloudProjectConfigEntry | SonarQubeServerProjectConfigEntry | CustomCloudProjectConfigEntry;

export interface ReadEntriesOptions {
  /**
   * Fail on a file that exists but cannot be read or parsed, as a write must not clobber it.
   * Otherwise such a file reads as empty.
   */
  strict: boolean;
}

/** The `.sonar-config.json` file format: the entries it holds, as written. */
export interface SharedProjectConfigFile {
  /** The valid entries of the `projects` array, or of the lone `project`; invalid ones are dropped. */
  readEntries(dir: string, options: ReadEntriesOptions): Promise<SharedProjectConfigEntry[]>;
  /**
   * Makes `entries` the projects `dir`'s config links: one is written as `project`, several as a
   * `projects` array. Other keys in the file are kept.
   */
  writeEntries(dir: string, entries: readonly SharedProjectConfigEntry[]): Promise<void>;
}

/** The projects a config links, as discovery uses them. */
export interface SharedProjectConfigRepository {
  /**
   * The projects `dir`'s config links, resolved to existing directories inside `dir` and to
   * server URLs. An unreadable file links nothing.
   */
  load(dir: string): Promise<SharedProjectConfigMapping[]>;
}

interface SharedProjectConfigFileDto {
  project?: unknown;
  /** Monorepo form: several mappings in one file. Takes precedence over `project` when present. */
  projects?: unknown;
}

const VALID_CLOUD_REGIONS = new Set<CloudRegion>(['eu', 'us']);

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
  if (!statSync(lexical, { throwIfNoEntry: false })?.isDirectory()) {
    return null;
  }
  const resolved = canonicalizePath(lexical);
  return isAncestorOrSelf(canonicalDir, resolved) ? resolved : null;
}

export class SharedProjectConfigFileImpl implements SharedProjectConfigFile {
  async readEntries(
    dir: string,
    { strict }: ReadEntriesOptions,
  ): Promise<SharedProjectConfigEntry[]> {
    const root = strict ? await this.readRootStrictly(dir) : await this.readRootLeniently(dir);
    if (strict && root.projects !== undefined && !Array.isArray(root.projects)) {
      throw new CommandFailedError(`${this.configPath(dir)} must contain a projects array`);
    }
    let rawEntries: unknown[] = [];
    if (Array.isArray(root.projects)) {
      rawEntries = root.projects;
    } else if (root.project !== undefined) {
      rawEntries = [root.project];
    }
    return rawEntries.filter((raw): raw is SharedProjectConfigEntry => {
      const valid = this.isValidEntry(raw);
      if (!valid) {
        logger.debug(`Dropping invalid ${SHARED_PROJECT_CONFIG_FILE_NAME} entry in ${dir}`);
      }
      return valid;
    });
  }

  async writeEntries(dir: string, entries: readonly SharedProjectConfigEntry[]): Promise<void> {
    const { project: _project, projects: _projects, ...rest } = await this.readRootStrictly(dir);
    const canonicalDir = canonicalizePath(dir);
    const normalized = entries.map((entry) => ({
      ...entry,
      path:
        relative(canonicalDir, canonicalizePath(join(dir, entry.path)))
          .split(sep)
          .join('/') || '.',
    }));
    let linked: SharedProjectConfigFileDto = {};
    if (normalized.length === 1) {
      linked = { project: normalized[0] };
    } else if (normalized.length > 1) {
      linked = { projects: normalized };
    }
    const file: SharedProjectConfigFileDto = { ...rest, ...linked };
    await writeFile(this.configPath(dir), JSON.stringify(file, null, 2), 'utf-8');
  }

  private configPath(dir: string): string {
    return join(dir, SHARED_PROJECT_CONFIG_FILE_NAME);
  }

  /** Only a genuinely absent file is empty; any other read or parse failure is thrown. */
  private async readRootStrictly(dir: string): Promise<SharedProjectConfigFileDto> {
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

  private async readRootLeniently(dir: string): Promise<SharedProjectConfigFileDto> {
    let content: string;
    try {
      content = await readFile(this.configPath(dir), 'utf-8');
    } catch {
      return {};
    }

    try {
      const parsed: unknown = JSON.parse(content);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      logger.debug(`Failed to parse ${this.configPath(dir)}: ${(error as Error).message}`);
      return {};
    }
  }

  private isValidEntry(value: unknown): value is SharedProjectConfigEntry {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const record = value as Record<string, unknown>;
    if (!this.isSingleLineString(record.projectKey) || !this.isSingleLineString(record.path)) {
      return false;
    }
    return (
      this.isCloudEntry(record) || this.isServerEntry(record) || this.isCustomCloudEntry(record)
    );
  }

  private isCloudEntry(value: Record<string, unknown>): boolean {
    return (
      value.serverUrl === undefined &&
      VALID_CLOUD_REGIONS.has(value.region as CloudRegion) &&
      this.isNonEmptyString(value.organization)
    );
  }

  private isServerEntry(value: Record<string, unknown>): boolean {
    return (
      value.region === undefined &&
      value.organization === undefined &&
      this.isNonEmptyString(value.serverUrl)
    );
  }

  private isCustomCloudEntry(value: Record<string, unknown>): boolean {
    return (
      value.region === undefined &&
      this.isNonEmptyString(value.organization) &&
      this.isNonEmptyString(value.serverUrl)
    );
  }

  /** A committed config is untrusted: a line break in a key or path would let it forge lines in hook and agent output. */
  private isSingleLineString(value: unknown): value is string {
    return this.isNonEmptyString(value) && !/[\r\n]/.test(value);
  }

  private isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }
}

export class SharedProjectConfigRepositoryImpl implements SharedProjectConfigRepository {
  constructor(private readonly file: SharedProjectConfigFile = new SharedProjectConfigFileImpl()) {}

  async load(dir: string): Promise<SharedProjectConfigMapping[]> {
    const entries = await this.file.readEntries(dir, { strict: false });
    return entries.flatMap((entry) => this.resolveEntry(dir, entry) ?? []);
  }

  private resolveEntry(
    dir: string,
    entry: SharedProjectConfigEntry,
  ): SharedProjectConfigMapping | null {
    const projectRoot = resolveContainedPath(dir, entry.path);
    if (projectRoot === null) {
      logger.debug(
        `Dropping ${SHARED_PROJECT_CONFIG_FILE_NAME} entry in ${dir}: "path" does not exist or escapes it`,
      );
      return null;
    }
    const { projectKey } = entry;
    if ('region' in entry) {
      return {
        projectRoot,
        projectKey,
        serverUrl: cloudRegionToUrl(entry.region),
        organization: entry.organization,
      };
    }
    const organization = 'organization' in entry ? entry.organization : undefined;
    return { projectRoot, projectKey, serverUrl: entry.serverUrl, organization };
  }
}

/** Shared singleton so `project-info.ts` and `link/index.ts` mock the same instance in tests via `spyOn`. */
export const sharedProjectConfigRepository: SharedProjectConfigRepository =
  new SharedProjectConfigRepositoryImpl();

/** Shared singleton for writers, which their tests `spyOn`. */
export const sharedProjectConfigFile: SharedProjectConfigFile = new SharedProjectConfigFileImpl();
