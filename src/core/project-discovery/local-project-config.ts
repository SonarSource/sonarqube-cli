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

// The sonar-project.properties / .sonarlint project-discovery source, climbed nearest-first by discoverProjects().

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { LookupPath } from '@/core/host/git/lookup-path-resolver.ts';
import { loadSonarLintConfig, type SonarLintConfig } from '@/core/host/sonarlint-connected-mode.ts';
import { parseProperties } from '@/core/io/properties.ts';
import logger from '@/core/observability/logger.ts';
import {
  formatConfigFields,
  selectValidServerUrl,
} from '@/core/project-discovery/project-discovery-format.ts';
import type {
  DiscoveredProject,
  DiscoverProjectOptions,
} from '@/core/project-discovery/project-info.ts';

export interface SonarProperties {
  hostURL: string;
  projectKey: string;
  projectName: string;
  organization: string;
}

/** Local config files found at exactly one directory — no git, no root resolution. */
interface LocalProjectConfig {
  hasSonarProps: boolean;
  sonarPropsData: SonarProperties | null;
  hasSonarLintConfig: boolean;
  sonarLintData: SonarLintConfig | null;
  /** Relative path from project root, e.g. `.sonarlint/connectedMode.json` or `.sonarlint/MySolution.json` */
  sonarLintConfigPath: string | null;
}

const SONAR_PROPERTY_FIELDS = new Map<string, keyof SonarProperties>([
  ['sonar.host.url', 'hostURL'],
  ['sonar.projectKey', 'projectKey'],
  ['sonar.projectName', 'projectName'],
  ['sonar.organization', 'organization'],
]);

async function loadSonarProperties(projectRoot: string): Promise<SonarProperties | null> {
  const propPath = join(projectRoot, 'sonar-project.properties');

  if (!existsSync(propPath)) {
    return null;
  }

  const fs = await import('node:fs/promises');
  const content = await fs.readFile(propPath, 'utf-8');

  const props: Partial<SonarProperties> = {};

  for (const [key, value] of parseProperties(content)) {
    const field = SONAR_PROPERTY_FIELDS.get(key);
    if (field) {
      props[field] = value;
    }
  }

  if (!props.hostURL && !props.projectKey) {
    return null;
  }

  return props as SonarProperties;
}

/** Loads sonar-project.properties/.sonarlint from exactly `dir` — no git, no root resolution. */
async function loadLocalProjectConfig(dir: string): Promise<LocalProjectConfig> {
  const sonarProps = await loadSonarProperties(dir);
  const sonarLintLoaded = await loadSonarLintConfig(dir);

  return {
    hasSonarProps: sonarProps !== null,
    sonarPropsData: sonarProps,
    hasSonarLintConfig: sonarLintLoaded !== null,
    sonarLintData: sonarLintLoaded?.config ?? null,
    sonarLintConfigPath: sonarLintLoaded?.relativePath ?? null,
  };
}

function applyLocalSonarProperties(
  config: DiscoveredProject,
  local: LocalProjectConfig,
  options: DiscoverProjectOptions,
): void {
  if (!local.hasSonarProps || !local.sonarPropsData) {
    return;
  }

  config.serverUrl = selectValidServerUrl(undefined, local.sonarPropsData.hostURL);
  config.projectKey = local.sonarPropsData.projectKey;
  config.organization = local.sonarPropsData.organization;

  if (options.silent) {
    return;
  }
  const fields = formatConfigFields(config.serverUrl, config.projectKey, config.organization);
  if (fields) {
    options.console.print(`Found sonar-project.properties: ${fields}`);
  }
}

/** Returns true once `config.projectKey` is resolved, so the caller can stop checking further sources. */
function applySonarLintConfig(
  config: DiscoveredProject,
  local: LocalProjectConfig,
  options: DiscoverProjectOptions,
): boolean {
  if (!local.hasSonarLintConfig || !local.sonarLintData || !local.sonarLintConfigPath) {
    return !!config.projectKey;
  }

  config.serverUrl = selectValidServerUrl(config.serverUrl, local.sonarLintData.serverURL);
  config.projectKey = config.projectKey || local.sonarLintData.projectKey;
  config.organization = config.organization || local.sonarLintData.organization;

  if (!options.silent) {
    const fields = formatConfigFields(
      local.sonarLintData.serverURL,
      local.sonarLintData.projectKey,
      local.sonarLintData.organization,
    );
    if (fields) {
      options.console.print(`Found ${local.sonarLintConfigPath}: ${fields}`);
    }
  }

  return !!config.projectKey;
}

/** Walks `lookupPaths` nearest-first for a `sonar-project.properties`/`.sonarlint` hit; a partial match doesn't stop the climb. */
export async function applyLocalConfigAcrossLookupPaths(
  config: DiscoveredProject,
  lookupPaths: LookupPath[],
  options: DiscoverProjectOptions,
): Promise<boolean> {
  for (const { checkPath, projectRoot } of lookupPaths) {
    let local: LocalProjectConfig;
    try {
      local = await loadLocalProjectConfig(checkPath);
    } catch (error) {
      // e.g. EACCES on a directory further up the climb — don't let one unreadable
      // path abort discovery for the whole call, same as the other two sources.
      logger.debug(`Local config lookup skipped for ${checkPath}: ${(error as Error).message}`);
      continue;
    }
    if (!local.hasSonarProps && !local.hasSonarLintConfig) {
      continue;
    }

    applyLocalSonarProperties(config, local, options);
    if (applySonarLintConfig(config, local, options)) {
      config.projectRoot = projectRoot;
      return true;
    }
  }

  return false;
}
