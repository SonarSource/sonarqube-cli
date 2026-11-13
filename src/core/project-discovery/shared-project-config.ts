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
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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

/** The fields the schema knows; an entry may carry others, such as `settings`, which are kept. */
export const SHARED_PROJECT_CONFIG_ENTRY_FIELDS: readonly string[] = [
  'projectKey',
  'path',
  'serverUrl',
  'region',
  'organization',
];

/** One project of the file's list, with the canonical folder its path names, existing or not. */
export interface ConfigItem {
  entry: SharedProjectConfigEntry;
  root: string;
}

/** Something in `.sonar-config.json` that is not valid config. */
export class InvalidSharedProjectConfigError extends CommandFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSharedProjectConfigError';
  }
}

/**
 * Told about each problem in the file. Throwing stops the read; returning skips what the problem
 * concerns: the whole file, or one item.
 */
export type OnInvalidConfig = (error: InvalidSharedProjectConfigError) => void;

/** The `.sonar-config.json` file format. */
export interface SharedProjectConfigFile {
  /**
   * The items of the `projects` array, or the lone `project`; a missing file holds none. A file
   * that is not valid JSON, an item outside the schema and a repeat of an already listed folder
   * each go to `onInvalid`.
   */
  readItems(dir: string, onInvalid: OnInvalidConfig): Promise<ConfigItem[]>;
  /**
   * Makes `items` the projects `dir`'s config links, each entry as it was read or built: one is
   * written as `project`, several as a `projects` array. Other keys in the file are kept, including
   * a `project` that sits beside a `projects` array, which readers ignore. Throws
   * {@link InvalidSharedProjectConfigError} without writing when the file is not valid JSON or two
   * items name the same folder.
   */
  writeItems(dir: string, items: readonly ConfigItem[]): Promise<void>;
}

/** For edits, which must not overwrite what they could not read. */
export const throwOnInvalidConfig: OnInvalidConfig = (error) => {
  throw error;
};

export interface LoadOptions {
  /** Told why a file or an item was ignored. Defaults to the log. */
  warn?: (message: string) => void;
}

/** The projects a config links, as discovery uses them. */
export interface SharedProjectConfigRepository {
  /**
   * The projects `dir`'s config links, resolved to existing directories inside `dir` and to
   * server URLs. A file that is not valid JSON, items outside the schema and repeats of an already
   * linked folder are ignored with a warning.
   */
  load(dir: string, options?: LoadOptions): Promise<SharedProjectConfigMapping[]>;
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
  async readItems(dir: string, onInvalid: OnInvalidConfig): Promise<ConfigItem[]> {
    let root: SharedProjectConfigFileDto;
    try {
      root = await this.readRoot(dir);
    } catch (error) {
      if (!(error instanceof InvalidSharedProjectConfigError)) throw error;
      onInvalid(error);
      return [];
    }
    let rawItems: unknown[] = [];
    if (Array.isArray(root.projects)) {
      rawItems = root.projects;
    } else if (root.project !== undefined) {
      rawItems = [root.project];
    }
    const items: ConfigItem[] = [];
    for (const [index, raw] of rawItems.entries()) {
      const item = this.isValidEntry(raw) ? this.toItem(dir, raw) : undefined;
      if (item !== undefined && !items.some((earlier) => earlier.root === item.root)) {
        items.push(item);
        continue;
      }
      const problem =
        item === undefined
          ? 'does not match the expected format'
          : `links ${this.relativePath(dir, item.root)}, which an earlier project already links`;
      onInvalid(
        new InvalidSharedProjectConfigError(
          `Project ${this.nameOf(raw, index)} in ${this.configPath(dir)} ${problem}`,
        ),
      );
    }
    return items;
  }

  async writeItems(dir: string, items: readonly ConfigItem[]): Promise<void> {
    const repeated = items.find((item, index) =>
      items.slice(0, index).some((earlier) => earlier.root === item.root),
    );
    if (repeated !== undefined) {
      throw new InvalidSharedProjectConfigError(
        `${this.configPath(dir)} would link ${this.relativePath(dir, repeated.root)} more than once`,
      );
    }
    const { project, projects, ...rest } = await this.readRoot(dir);
    const values = items.map((item) => item.entry);
    let linked: SharedProjectConfigFileDto = {};
    if (Array.isArray(projects) && project !== undefined) {
      // Readers ignore a `project` beside a `projects` array; keeping both keeps it ignored.
      linked = { project, projects: values };
    } else if (values.length === 1) {
      linked = { project: values[0] };
    } else if (values.length > 1) {
      linked = { projects: values };
    }
    const file: SharedProjectConfigFileDto = { ...rest, ...linked };
    await writeFile(this.configPath(dir), JSON.stringify(file, null, 2), 'utf-8');
  }

  private configPath(dir: string): string {
    return join(dir, SHARED_PROJECT_CONFIG_FILE_NAME);
  }

  /** A missing file is empty; one that is not valid JSON config throws, as a write must not clobber it. */
  private async readRoot(dir: string): Promise<SharedProjectConfigFileDto> {
    let content: string;
    try {
      content = await readFile(this.configPath(dir), 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new InvalidSharedProjectConfigError(
        `${this.configPath(dir)} is not valid JSON: ${(error as Error).message}`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new InvalidSharedProjectConfigError(
        `${this.configPath(dir)} does not contain a JSON object`,
      );
    }
    const root: SharedProjectConfigFileDto = parsed;
    if (root.projects !== undefined && !Array.isArray(root.projects)) {
      throw new InvalidSharedProjectConfigError(
        `${this.configPath(dir)} must contain a projects array`,
      );
    }
    return root;
  }

  /** The item's project key when it has a usable one, else its position in the list. */
  private nameOf(raw: unknown, index: number): string {
    const key =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>).projectKey
        : undefined;
    return this.isSingleLineString(key) ? key : `#${index + 1}`;
  }

  private toItem(dir: string, entry: SharedProjectConfigEntry): ConfigItem {
    return { entry, root: canonicalizePath(resolve(dir, entry.path)) };
  }

  private relativePath(dir: string, root: string): string {
    return relative(canonicalizePath(dir), root).split(sep).join('/') || '.';
  }

  private isValidEntry(value: unknown): value is SharedProjectConfigEntry {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    if (!this.isSingleLineString(record.projectKey) || !this.isSingleLineString(record.path)) {
      return false;
    }
    // Paths are relative to the config directory; an absolute one could not be written back as such.
    if (isAbsolute(record.path)) {
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

  async load(dir: string, options: LoadOptions = {}): Promise<SharedProjectConfigMapping[]> {
    const warn =
      options.warn ??
      ((message: string) => {
        logger.warn(message);
      });
    const items = await this.file.readItems(dir, (error) => {
      warn(`${error.message}; ignoring it.`);
    });
    return items.flatMap((item) => this.resolveEntry(dir, item.entry) ?? []);
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
