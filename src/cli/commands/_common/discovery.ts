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

// Discovery module - discovers project information

import { existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { spawnProcess } from '../../../lib/process';
import logger from '../../../lib/logger';
import { print, text } from '../../../ui';

export interface ProjectInfo {
  root: string;
  name: string;
  isGitRepo: boolean;
  gitRemote: string;
  hasSonarProps: boolean;
  sonarPropsData: SonarProperties | null;
  hasSonarLintConfig: boolean;
  sonarLintData: SonarLintConfig | null;
}

export interface DiscoveredProject {
  rootDir: string;
  isGitRepo: boolean;
  serverUrl?: string;
  organization?: string;
  projectKey?: string;
}

export interface SonarProperties {
  hostURL: string;
  projectKey: string;
  projectName: string;
  organization: string;
}

export interface SonarLintConfig {
  serverURL: string;
  projectKey: string;
  organization: string;
}

/**
 * Try to find server URL from project configs
 */
export async function discoverServer(): Promise<string | null> {
  try {
    const projectInfo = await discoverProjectInfo(process.cwd());

    // Check sonar-project.properties first
    if (projectInfo.sonarPropsData?.hostURL) {
      const url = projectInfo.sonarPropsData.hostURL;
      print(`Found server in sonar-project.properties: ${url}`);
      return url;
    }

    // Check .sonarlint config
    if (projectInfo.sonarLintData?.serverURL) {
      const url = projectInfo.sonarLintData.serverURL;
      print(`Found server in .sonarlint config: ${url}`);
      return url;
    }

    return null;
  } catch (error) {
    logger.debug(`Error finding server in configs: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Try to find organization from project configs
 */
export async function discoverOrganization(): Promise<string | null> {
  try {
    const projectInfo = await discoverProjectInfo(process.cwd());

    // Check sonar-project.properties
    if (projectInfo.sonarPropsData?.organization) {
      return projectInfo.sonarPropsData.organization;
    }

    // Check .sonarlint config
    if (projectInfo.sonarLintData?.organization) {
      return projectInfo.sonarLintData.organization;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Discover project information from the current directory
 */
export async function discoverProjectInfo(startDir: string): Promise<ProjectInfo> {
  const { gitRoot, isGit } = findGitRoot(startDir);

  const projectRoot = isGit ? gitRoot : startDir;
  const projectName = basename(projectRoot);

  let gitRemote = '';
  if (isGit) {
    gitRemote = await getGitRemote(projectRoot);
  }

  const sonarProps = await loadSonarProperties(projectRoot);
  const sonarLintConfig = await loadSonarLintConfig(projectRoot);

  return {
    root: projectRoot,
    name: projectName,
    isGitRepo: isGit,
    gitRemote,
    hasSonarProps: sonarProps !== null,
    sonarPropsData: sonarProps,
    hasSonarLintConfig: sonarLintConfig !== null,
    sonarLintData: sonarLintConfig,
  };
}

export async function discoverProject(startDir: string): Promise<DiscoveredProject> {
  const projectInfo = await discoverProjectInfo(startDir);
  const config: DiscoveredProject = {
    rootDir: projectInfo.root,
    isGitRepo: projectInfo.isGitRepo,
  };

  if (projectInfo.hasSonarProps && projectInfo.sonarPropsData) {
    text('Found sonar-project.properties');
    config.serverUrl = projectInfo.sonarPropsData.hostURL;
    config.projectKey = projectInfo.sonarPropsData.projectKey;
    config.organization = projectInfo.sonarPropsData.organization;
  }

  if (projectInfo.hasSonarLintConfig && projectInfo.sonarLintData) {
    text('Found .sonarlint/connectedMode.json');
    config.serverUrl = config.serverUrl || projectInfo.sonarLintData.serverURL;
    config.projectKey = config.projectKey || projectInfo.sonarLintData.projectKey;
    config.organization = config.organization || projectInfo.sonarLintData.organization;
  }

  return config;
}

function findGitRoot(startDir: string): { gitRoot: string; isGit: boolean } {
  let dir = startDir;

  for (;;) {
    const gitDir = join(dir, '.git');

    if (existsSync(gitDir)) {
      const stat = statSync(gitDir);
      // Accept both directory (.git/) and file (.git worktree pointer)
      if (stat.isDirectory() || stat.isFile()) {
        return { gitRoot: dir, isGit: true };
      }
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return { gitRoot: '', isGit: false };
}

async function getGitRemote(gitRoot: string): Promise<string> {
  try {
    const result = await spawnProcess('git', ['remote', 'get-url', 'origin'], { cwd: gitRoot });
    if (result.exitCode === 0) {
      return result.stdout.trim();
    }
  } catch (error) {
    logger.debug(`Failed to get git remote: ${(error as Error).message}`);
  }
  return '';
}

function parsePropertyLine(line: string, props: Partial<SonarProperties>): void {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith('#')) {
    return;
  }

  // Split only on the first '=' to allow '=' in values
  const eqIndex = trimmed.indexOf('=');
  if (eqIndex === -1) {
    return;
  }

  const key = trimmed.slice(0, eqIndex).trim();
  const value = trimmed.slice(eqIndex + 1).trim();

  const propertyMap: Record<string, keyof SonarProperties> = {
    'sonar.host.url': 'hostURL',
    'sonar.projectKey': 'projectKey',
    'sonar.projectName': 'projectName',
    'sonar.organization': 'organization',
  };

  if (key in propertyMap) {
    props[propertyMap[key]] = value;
  }
}

async function loadSonarProperties(projectRoot: string): Promise<SonarProperties | null> {
  const propPath = join(projectRoot, 'sonar-project.properties');

  if (!existsSync(propPath)) {
    return null;
  }

  const fs = await import('node:fs/promises');
  const content = await fs.readFile(propPath, 'utf-8');

  const props: Partial<SonarProperties> = {};

  for (const line of content.split('\n')) {
    parsePropertyLine(line, props);
  }

  if (!props.hostURL && !props.projectKey) {
    return null;
  }

  return props as SonarProperties;
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

async function loadSonarLintConfig(projectRoot: string): Promise<SonarLintConfig | null> {
  const possiblePaths = [
    join(projectRoot, '.sonarlint', 'connectedMode.json'),
    join(projectRoot, '.sonarlint', 'connected-mode.json'),
    join(projectRoot, '.sonarlint', 'settings.json'),
  ];

  for (const configPath of possiblePaths) {
    const config = await tryLoadSonarLintFile(configPath);
    if (config) {
      return config;
    }
  }

  return null;
}

function parseSonarLintConfig(data: string): SonarLintConfig | null {
  try {
    const generic = JSON.parse(data);

    // Schema 1: connectedMode.json format
    if ('sonarQubeUri' in generic) {
      return {
        serverURL: generic.sonarQubeUri || '',
        projectKey: generic.projectKey || '',
        organization: generic.organization || '',
      };
    }

    // Schema 2: settings.json format (legacy)
    if ('serverId' in generic) {
      return {
        serverURL: generic.serverId || '',
        projectKey: generic.projectKey || '',
        organization: generic.organization || '',
      };
    }

    // Schema 3: connectionId format
    if ('connectionId' in generic) {
      return {
        serverURL: generic.connectionId || '',
        projectKey: generic.projectKey || '',
        organization: generic.organization || '',
      };
    }

    return null;
  } catch {
    return null;
  }
}
