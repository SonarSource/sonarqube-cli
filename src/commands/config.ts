// Config command - manage analyze configuration

import { loadAnalyzeConfig, saveAnalyzeConfig, getConfigLocation, configExists } from '../lib/analyze-config.js';
import { unlinkSync } from 'node:fs';

const TOKEN_DISPLAY_SUFFIX_LENGTH = 4;

export interface ConfigOptions {
  show?: boolean;
  clear?: boolean;
  set?: boolean;
  organizationKey?: string;
  projectKey?: string;
  token?: string;
}

/**
 * Show current configuration
 */
function showConfig(): void {
  console.log(`Config location: ${getConfigLocation()}`);

  if (!configExists()) {
    console.log('\n❌ No config file found');
    console.log('\nTo create config, run:');
    console.log('  sonar analyze --file <file> --organization-key <key> --project-key <key> --token <token> --save-config');
    return;
  }

  const config = loadAnalyzeConfig();
  if (config) {
    console.log('\n✅ Current configuration:');
    console.log(`  Organization Key: ${config.organizationKey}`);
    console.log(`  Project Key: ${config.projectKey || '(not set)'}`);
    console.log(`  Token: ${config.token ? '***' + config.token.slice(-TOKEN_DISPLAY_SUFFIX_LENGTH) : '(not set)'}`);
  }
}

/**
 * Clear configuration
 */
function clearConfig(): void {
  if (!configExists()) {
    console.log('❌ No config file found');
    return;
  }

  try {
    unlinkSync(getConfigLocation());
    console.log('✅ Config file cleared');
  } catch (error) {
    console.error('Error clearing config:', (error as Error).message);
    process.exit(1);
  }
}

/**
 * Set configuration values
 */
function setConfig(options: ConfigOptions): void {
  const config = loadAnalyzeConfig() || {
    organizationKey: '',
    token: '',
    projectKey: ''
  };

  let updated = false;

  if (options.organizationKey) {
    config.organizationKey = options.organizationKey;
    updated = true;
  }

  if (options.projectKey) {
    config.projectKey = options.projectKey;
    updated = true;
  }

  if (options.token) {
    config.token = options.token;
    updated = true;
  }

  if (!updated) {
    console.error('Error: Please provide at least one value to set (--organization-key, --project-key, or --token)');
    process.exit(1);
  }

  saveAnalyzeConfig(config);
  console.log(`✅ Config updated at: ${getConfigLocation()}`);
}

/**
 * Show help information
 */
function showHelp(): void {
  console.log('Usage: sonar config [options]');
  console.log('\nOptions:');
  console.log('  --show              Show current configuration');
  console.log('  --clear             Clear configuration file');
  console.log('  --set               Set configuration values');
  console.log('  --organization-key  Organization key to set');
  console.log('  --project-key       Project key to set');
  console.log('  --token             Token to set');
  console.log('\nExamples:');
  console.log('  sonar config --show');
  console.log('  sonar config --set --organization-key sonarsource --token TOKEN');
  console.log('  sonar config --clear');
}

/**
 * Config command handler
 */
export async function configCommand(options: ConfigOptions): Promise<void> {
  if (options.show) {
    showConfig();
    return;
  }

  if (options.clear) {
    clearConfig();
    return;
  }

  if (options.set) {
    setConfig(options);
    return;
  }

  showHelp();
}
