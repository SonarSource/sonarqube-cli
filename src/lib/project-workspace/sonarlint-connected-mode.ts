/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// SonarLint `.sonarlint` connected mode files (connectedMode.json + solution JSON)

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SONARCLOUD_URL, SONARCLOUD_US_URL } from '../config-constants';

export interface SonarLintConfig {
  serverURL: string;
  projectKey: string;
  organization: string;
}

export interface LoadedSonarLintConfig {
  config: SonarLintConfig;
  /** Path relative to the project root (via path.join). */
  relativePath: string;
}

/** SonarLint uses `connectedMode.json` (any casing) or `<solutionName>.json` under `.sonarlint/`. */
const CONNECTED_MODE_FILE_LOWER = 'connectedmode.json';

function isSonarLintConnectedModeFileName(fileName: string): boolean {
  return fileName.toLowerCase() === CONNECTED_MODE_FILE_LOWER;
}

function sonarCloudBaseUrlFromRegion(region: unknown): string {
  if (typeof region === 'string' && region.trim().toUpperCase() === 'US') {
    return SONARCLOUD_US_URL;
  }
  return SONARCLOUD_URL;
}

function parseStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseSonarLintConfig(data: string): SonarLintConfig | null {
  try {
    const generic = JSON.parse(data) as Record<string, unknown>;

    // SonarQube Server: sonarQubeUri + projectKey
    if ('sonarQubeUri' in generic) {
      const serverURL = parseStringValue(generic.sonarQubeUri).trim();
      const projectKey = parseStringValue(generic.projectKey).trim();
      if (!serverURL || !projectKey) {
        return null;
      }
      return {
        serverURL,
        projectKey,
        organization: '',
      };
    }

    // SonarQube Cloud: sonarCloudOrganization + projectKey, optional region
    if ('sonarCloudOrganization' in generic) {
      const organization = parseStringValue(generic.sonarCloudOrganization).trim();
      const projectKey = parseStringValue(generic.projectKey).trim();
      if (organization && projectKey) {
        return {
          serverURL: sonarCloudBaseUrlFromRegion(generic.region),
          projectKey,
          organization,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function tryLoadSonarLintFile(configPath: string): Promise<SonarLintConfig | null> {
  const fs = await import('node:fs/promises');

  try {
    const data = await fs.readFile(configPath, 'utf-8');
    const config = parseSonarLintConfig(data);
    if (config && (config.serverURL || config.projectKey)) {
      return config;
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  return null;
}

/**
 * Loads the first valid SonarLint connected-mode config under `.sonarlint/`:
 * tries `connectedMode.json` (any casing), then other `*.json` files (e.g. solution bindings).
 */
export async function loadSonarLintConfig(
  projectRoot: string,
): Promise<LoadedSonarLintConfig | null> {
  const sonarlintDir = join(projectRoot, '.sonarlint');
  if (!existsSync(sonarlintDir)) {
    return null;
  }

  const fs = await import('node:fs/promises');
  let entries: string[];
  try {
    entries = await fs.readdir(sonarlintDir);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  const jsonFiles = entries.filter((f) => f.toLowerCase().endsWith('.json'));

  // Try loading connectedMode.json first
  const connectedModeCandidates = jsonFiles
    .filter(isSonarLintConnectedModeFileName)
    .sort((a, b) => a.localeCompare(b));

  for (const name of connectedModeCandidates) {
    const config = await tryLoadSonarLintFile(join(sonarlintDir, name));
    if (config) {
      return { config, relativePath: join('.sonarlint', name) };
    }
  }

  // Fall back to other JSON files (e.g., solution projects)
  const solutionJsonFiles = jsonFiles
    .filter((f) => !isSonarLintConnectedModeFileName(f))
    .sort((a, b) => a.localeCompare(b));

  for (const name of solutionJsonFiles) {
    const config = await tryLoadSonarLintFile(join(sonarlintDir, name));
    if (config) {
      return { config, relativePath: join('.sonarlint', name) };
    }
  }

  return null;
}
