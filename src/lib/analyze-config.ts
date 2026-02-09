// Analyze command configuration management

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface AnalyzeConfig {
  organizationKey: string;
  token: string;
  projectKey?: string;
}

const CONFIG_DIR = join(homedir(), '.sonar-cli');
const CONFIG_FILE = 'analyze-config.json';

/**
 * Get config file path
 */
function getConfigPath(): string {
  return join(CONFIG_DIR, CONFIG_FILE);
}

/**
 * Ensure config directory exists
 */
function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Load analyze configuration
 */
export function loadAnalyzeConfig(): AnalyzeConfig | null {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const data = readFileSync(configPath, 'utf-8');
    return JSON.parse(data) as AnalyzeConfig;
  } catch (error) {
    console.error(`Warning: Failed to parse config file: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Save analyze configuration
 */
export function saveAnalyzeConfig(config: AnalyzeConfig): void {
  ensureConfigDir();
  const configPath = getConfigPath();
  const data = JSON.stringify(config, null, 2);
  writeFileSync(configPath, data, { mode: 0o600 });
}

/**
 * Get config file location for display
 */
export function getConfigLocation(): string {
  return getConfigPath();
}

/**
 * Check if config file exists
 */
export function configExists(): boolean {
  return existsSync(getConfigPath());
}
