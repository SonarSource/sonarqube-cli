// MCP Server configuration - manages Claude Code MCP settings

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import logger from '../lib/logger.js';

interface MCPServer {
  type: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface ClaudeConfig {
  mcpServers?: Record<string, MCPServer>;
  [key: string]: unknown;
}

interface ProjectSettings {
  mcpServers?: Record<string, MCPServer>;
  hooks?: unknown;
  permissions?: {
    allow: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const CLAUDE_DIR = '.claude';
const SETTINGS_FILE = 'settings.local.json';

/**
 * Get Claude config path
 * Claude Code reads MCP configuration from ~/.claude.json
 * This is the official location for user-scoped MCP servers
 */
function getClaudeConfigPath(): string {
  return join(homedir(), '.claude.json');
}

/**
 * Load Claude config
 */
async function loadClaudeConfig(): Promise<ClaudeConfig> {
  const configPath = getClaudeConfigPath();

  if (!existsSync(configPath)) {
    // Return empty config if file doesn't exist yet
    return { mcpServers: {} };
  }

  const fs = await import('node:fs/promises');
  const data = await fs.readFile(configPath, 'utf-8');
  return JSON.parse(data);
}

/**
 * Save Claude config
 */
async function saveClaudeConfig(config: ClaudeConfig): Promise<void> {
  const configPath = getClaudeConfigPath();
  const configDir = dirname(configPath);

  const fs = await import('node:fs/promises');
  const { mkdirSync } = await import('node:fs');

  // Ensure directory exists
  if (platform() === 'win32') {
    mkdirSync(configDir, { recursive: true });
  } else {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  const data = JSON.stringify(config, null, 2);
  await fs.writeFile(configPath, data, 'utf-8');
}

/**
 * Configure MCP Server in Claude Code settings
 * Writes to ~/.claude.json (the official MCP configuration location for Claude Code)
 * Uses a simple 'sonarqube' key for the server
 * This allows Claude Code to discover the MCP server and tools
 */
export async function configureMCPServer(
  serverURL: string,
  token: string,
  organization?: string
): Promise<void> {
  const config = await loadClaudeConfig();

  // Get or create mcpServers section
  config.mcpServers ??= {};

  // Build and assign MCP server configuration directly
  const args = ['run', '-i', '--rm', '-e', 'SONARQUBE_TOKEN', '-e', 'SONARQUBE_URL'];
  const env: Record<string, string> = {
    SONARQUBE_TOKEN: token,
    SONARQUBE_URL: serverURL
  };

  if (organization) {
    args.push('-e', 'SONARQUBE_ORG');
    env.SONARQUBE_ORG = organization;
  }

  args.push('mcp/sonarqube');

  // Use simple 'sonarqube' key for global configuration
  // This ensures Claude Code can discover the MCP server and tools
  config.mcpServers.sonarqube = {
    type: 'stdio',
    command: 'docker',
    args,
    env
  };

  // Save updated config
  await saveClaudeConfig(config);
}

/**
 * Check if MCP Server is configured
 * Checks for the standard 'sonarqube' key in ~/.claude.json
 */
export async function isMCPServerConfigured(): Promise<boolean> {
  try {
    const config = await loadClaudeConfig();

    if (!config.mcpServers) {
      return false;
    }

    // Check for 'sonarqube' key in global configuration
    return 'sonarqube' in config.mcpServers;
  } catch {
    return false;
  }
}

/**
 * Get project settings path
 */
function getProjectSettingsPath(projectRoot: string): string {
  return join(projectRoot, CLAUDE_DIR, SETTINGS_FILE);
}

/**
 * Load project settings
 */
async function loadProjectSettings(projectRoot: string): Promise<ProjectSettings> {
  const settingsPath = getProjectSettingsPath(projectRoot);

  if (!existsSync(settingsPath)) {
    return { mcpServers: {} };
  }

  const fs = await import('node:fs/promises');
  const data = await fs.readFile(settingsPath, 'utf-8');
  return JSON.parse(data);
}

/**
 * Save project settings
 */
async function saveProjectSettings(projectRoot: string, settings: ProjectSettings): Promise<void> {
  const claudePath = join(projectRoot, CLAUDE_DIR);

  // Create .claude directory if needed
  if (!existsSync(claudePath)) {
    const { mkdirSync } = await import('node:fs');
    if (platform() === 'win32') {
      mkdirSync(claudePath, { recursive: true });
    } else {
      mkdirSync(claudePath, { recursive: true, mode: 0o755 });
    }
  }

  const settingsPath = getProjectSettingsPath(projectRoot);
  const fs = await import('node:fs/promises');
  const data = JSON.stringify(settings, null, 2);
  await fs.writeFile(settingsPath, data, 'utf-8');
}

/**
 * Build MCP server configuration
 */
function buildMCPServerConfig(
  serverURL: string,
  token: string,
  projectKey?: string,
  organization?: string
): MCPServer {
  const args = ['run', '-i', '--rm', '-e', 'SONARQUBE_TOKEN', '-e', 'SONARQUBE_URL'];
  const env: Record<string, string> = {
    SONARQUBE_TOKEN: token,
    SONARQUBE_URL: serverURL
  };

  if (projectKey) {
    args.push('-e', 'SONARQUBE_PROJECT');
    env.SONARQUBE_PROJECT = projectKey;
  }

  if (organization) {
    args.push('-e', 'SONARQUBE_ORG');
    env.SONARQUBE_ORG = organization;
  }

  args.push('mcp/sonarqube');

  return {
    type: 'stdio',
    command: 'docker',
    args,
    env
  };
}

/**
 * Configure project-specific MCP server
 * This is the recommended approach as it isolates configuration per project
 * and doesn't interfere with global or other project configurations
 */
export async function configureProjectMCPServer(
  projectRoot: string,
  serverURL: string,
  token: string,
  projectKey: string,
  organization?: string
): Promise<void> {
  // Load existing settings (preserving hooks, permissions, etc.)
  const settings = await loadProjectSettings(projectRoot);

  // Ensure mcpServers section exists
  settings.mcpServers ??= {};

  // Build and assign server configuration directly
  settings.mcpServers.sonarqube = buildMCPServerConfig(serverURL, token, projectKey, organization);

  // Ensure permissions section exists
  settings.permissions ??= {allow: []};
  if (!Array.isArray(settings.permissions.allow)) {
    settings.permissions.allow = [];
  }

  // Add MCP tool permission if not already present
  const mcpToolPermission = 'mcp__sonarqube__analyze_code_snippet';
  if (!settings.permissions.allow.includes(mcpToolPermission)) {
    settings.permissions.allow.unshift(mcpToolPermission);
  }

  // Save updated settings
  await saveProjectSettings(projectRoot, settings);
}

/**
 * Check if project-specific MCP server is configured
 */
export async function isProjectMCPServerConfigured(projectRoot: string): Promise<boolean> {
  try {
    const settings = await loadProjectSettings(projectRoot);
    return !!(settings.mcpServers && 'sonarqube' in settings.mcpServers);
  } catch {
    return false;
  }
}

/**
 * Clean up old project-specific MCP configuration
 * Removes MCP servers section from project settings after migration to global config
 */
export async function cleanupProjectMCPConfig(projectRoot: string): Promise<void> {
  try {
    const settings = await loadProjectSettings(projectRoot);

    // If mcpServers section exists, remove it
    if (settings.mcpServers) {
      delete settings.mcpServers;
      // Save updated settings (removing mcpServers but keeping hooks and permissions)
      await saveProjectSettings(projectRoot, settings);
    }
  } catch (error) {
    logger.debug(`Failed to save MCP project settings: ${(error as Error).message}`);
  }
}
