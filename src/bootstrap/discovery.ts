// Discovery module - discovers project information

import { existsSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { spawnProcess } from '../lib/process.js';

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

export interface SonarProperties {
  hostURL: string;
  projectKey: string;
  projectName: string;
  organization: string;
  login: string;
  sources: string;
  tests: string;
}

export interface SonarLintConfig {
  serverURL: string;
  projectKey: string;
  organization: string;
}

/**
 * Discover project information from the current directory
 */
export async function discoverProject(startDir: string, verbose: boolean = false): Promise<ProjectInfo> {
  // Find git root
  const { gitRoot, isGit } = findGitRoot(startDir);

  const projectRoot = isGit ? gitRoot : startDir;
  const projectName = basename(projectRoot);

  // Get git remote if available
  let gitRemote = '';
  if (isGit) {
    gitRemote = await getGitRemote(projectRoot);
  }

  // Check for sonar-project.properties
  const sonarProps = await loadSonarProperties(projectRoot, verbose);

  // Check for .sonarlint configuration
  const sonarLintConfig = await loadSonarLintConfig(projectRoot, verbose);

  return {
    root: projectRoot,
    name: projectName,
    isGitRepo: isGit,
    gitRemote,
    hasSonarProps: sonarProps !== null,
    sonarPropsData: sonarProps,
    hasSonarLintConfig: sonarLintConfig !== null,
    sonarLintData: sonarLintConfig
  };
}

/**
 * Find git repository root starting from the given directory
 */
function findGitRoot(startDir: string): { gitRoot: string; isGit: boolean } {
  let dir = startDir;

  while (true) {
    const gitDir = join(dir, '.git');

    if (existsSync(gitDir)) {
      const stat = statSync(gitDir);
      if (stat.isDirectory()) {
        return { gitRoot: dir, isGit: true };
      }
    }

    const parent = dirname(dir);
    if (parent === dir) {
      // Reached root
      break;
    }
    dir = parent;
  }

  return { gitRoot: '', isGit: false };
}

/**
 * Get git remote URL
 */
async function getGitRemote(gitRoot: string): Promise<string> {
  try {
    const result = await spawnProcess('git', ['remote', 'get-url', 'origin'], { cwd: gitRoot });
    if (result.exitCode === 0) {
      return result.stdout.trim();
    }
  } catch {
    // Ignore errors
  }
  return '';
}

/**
 * Suggest a project key based on git remote or directory name
 */
export function suggestProjectKey(projectInfo: ProjectInfo): string {
  if (projectInfo.gitRemote) {
    // Extract from git remote
    // Example: git@github.com:user/repo.git -> user_repo
    let remote = projectInfo.gitRemote;

    // Remove protocol
    remote = remote.replace(/^https?:\/\//, '');
    remote = remote.replace(/^git@/, '');

    // Remove .git suffix
    remote = remote.replace(/\.git$/, '');

    // Replace special characters
    remote = remote.replace(/:/g, '/');
    remote = remote.replace(/\//g, '_');

    if (remote) {
      return remote;
    }
  }

  // Fallback to directory name
  return projectInfo.name.replace(/-/g, '_');
}

/**
 * Check if Docker is available
 */
export async function checkDockerAvailable(): Promise<boolean> {
  try {
    const result = await spawnProcess('docker', ['version']);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Load sonar-project.properties file if it exists
 */
async function loadSonarProperties(projectRoot: string, verbose: boolean): Promise<SonarProperties | null> {
  const propPath = join(projectRoot, 'sonar-project.properties');

  if (!existsSync(propPath)) {
    return null;
  }

  if (verbose) {
    console.log(`   Debug: Parsing sonar-project.properties from: ${propPath}`);
  }

  const fs = await import('fs/promises');
  const content = await fs.readFile(propPath, 'utf-8');

  const props: Partial<SonarProperties> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Parse key=value
    const parts = trimmed.split('=');
    if (parts.length !== 2) {
      continue;
    }

    const key = parts[0].trim();
    const value = parts[1].trim();

    switch (key) {
      case 'sonar.host.url':
        props.hostURL = value;
        if (verbose) console.log(`   Debug: Found sonar.host.url="${value}"`);
        break;
      case 'sonar.projectKey':
        props.projectKey = value;
        if (verbose) console.log(`   Debug: Found sonar.projectKey="${value}"`);
        break;
      case 'sonar.projectName':
        props.projectName = value;
        if (verbose) console.log(`   Debug: Found sonar.projectName="${value}"`);
        break;
      case 'sonar.organization':
        props.organization = value;
        if (verbose) console.log(`   Debug: Found sonar.organization="${value}"`);
        break;
      case 'sonar.login':
        props.login = value;
        if (verbose) console.log(`   Debug: Found sonar.login="${value}"`);
        break;
      case 'sonar.sources':
        props.sources = value;
        break;
      case 'sonar.tests':
        props.tests = value;
        break;
    }
  }

  // Return null if no relevant properties found
  if (!props.hostURL && !props.projectKey) {
    return null;
  }

  return props as SonarProperties;
}

/**
 * Load .sonarlint config files if they exist
 */
async function loadSonarLintConfig(projectRoot: string, verbose: boolean): Promise<SonarLintConfig | null> {
  const possiblePaths = [
    join(projectRoot, '.sonarlint', 'connectedMode.json'),
    join(projectRoot, '.sonarlint', 'connected-mode.json'),
    join(projectRoot, '.sonarlint', 'settings.json')
  ];

  if (verbose) {
    console.log(`   Debug: Looking for SonarLint config in: ${projectRoot}`);
  }

  const fs = await import('fs/promises');

  for (const configPath of possiblePaths) {
    try {
      const data = await fs.readFile(configPath, 'utf-8');
      if (verbose) {
        console.log(`   Debug: Found SonarLint config: ${configPath}`);
        console.log(`   Debug: Content: ${data}`);
      }

      const config = parseSonarLintConfig(data);
      if (config && (config.serverURL || config.projectKey)) {
        return config;
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        if (verbose) {
          console.log(`   Debug: File not found: ${configPath}`);
        }
        continue;
      }
      throw error;
    }
  }

  return null;
}

/**
 * Parse SonarLint config with different schemas
 */
function parseSonarLintConfig(data: string): SonarLintConfig | null {
  try {
    const generic = JSON.parse(data);

    // Schema 1: connectedMode.json format
    if ('sonarQubeUri' in generic) {
      return {
        serverURL: generic.sonarQubeUri || '',
        projectKey: generic.projectKey || '',
        organization: generic.organization || ''
      };
    }

    // Schema 2: settings.json format (legacy)
    if ('serverId' in generic) {
      return {
        serverURL: generic.serverId || '',
        projectKey: generic.projectKey || '',
        organization: generic.organization || ''
      };
    }

    // Schema 3: connectionId format
    if ('connectionId' in generic) {
      return {
        serverURL: generic.connectionId || '',
        projectKey: generic.projectKey || '',
        organization: generic.organization || ''
      };
    }

    return null;
  } catch {
    return null;
  }
}
