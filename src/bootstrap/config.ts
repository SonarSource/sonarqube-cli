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

// Config management - load and save sonarqube-cli configuration

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Config {
  version: string;
  sonarqube: SonarQubeConfig;
  mcp: MCPConfig;
  project: ProjectConfig;
}

export interface SonarQubeConfig {
  serverUrl: string;
  projectKey: string;
  organization?: string;
  tokenSource: string; // "keychain" or "env"
}

export interface MCPConfig {
  serverPath?: string;
  enabled: boolean;
}

export interface ProjectConfig {
  root: string;
  name: string;
}

const CONFIG_VERSION = '1.0';
const CONFIG_DIR = '.sonarqube';
const CONFIG_FILE = 'config.json';

/**
 * Load configuration from project directory
 */
export async function loadConfig(projectRoot: string): Promise<Config | null> {
  const configPath = join(projectRoot, CONFIG_DIR, CONFIG_FILE);

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const fs = await import('node:fs/promises');
    const data = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(data) as Config;
  } catch (error) {
    throw new Error(`Failed to parse config: ${error}`);
  }
}

/**
 * Save configuration to project directory
 */
export async function saveConfig(projectRoot: string, config: Config): Promise<void> {
  const configDir = join(projectRoot, CONFIG_DIR);

  // Create .sonarqube directory if it doesn't exist
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o755 });
  }

  const configPath = join(configDir, CONFIG_FILE);

  const fs = await import('node:fs/promises');
  const data = JSON.stringify(config, null, 2);
  await fs.writeFile(configPath, data, { mode: 0o644 });
}

/**
 * Create a new configuration with the given parameters
 */
export function newConfig(
  projectRoot: string,
  projectName: string,
  serverURL: string,
  projectKey: string,
  organization?: string
): Config {
  return {
    version: CONFIG_VERSION,
    sonarqube: {
      serverUrl: serverURL,
      projectKey,
      organization,
      tokenSource: 'keychain'
    },
    mcp: {
      enabled: true
    },
    project: {
      root: projectRoot,
      name: projectName
    }
  };
}
