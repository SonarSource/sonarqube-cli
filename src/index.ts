#!/usr/bin/env node

// Main CLI entry point
// Generated from cli-spec.yaml by Plop.js

import { Command } from 'commander';
import { verifyCommand } from './commands/verify.js';
import { issuesSearchCommand } from './commands/issues.js';
import { onboardAgentCommand } from './commands/onboard-agent.js';
import { authLoginCommand } from './commands/auth.js';
import { authLogoutCommand } from './commands/auth.js';
import { authPurgeCommand } from './commands/auth.js';

const program = new Command();

program
  .name('sonar')
  .description('SonarQube CLI for AI coding agents')
  .version('0.2.61');

// Analyze a file for code issues
program
  .command('verify')
  .description('Analyze a file for code issues')
  .requiredOption('--file <file>', 'File path to analyze')
  .action(async (options) => {
    try {
      await verifyCommand(options);
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

// Manage SonarQube issues
const issues = program
  .command('issues')
  .description('Manage SonarQube issues');

issues
  .command('search')
  .description('Search for issues in SonarQube')
  .requiredOption('-s, --server <server>', 'SonarQube server URL')
  .option('-t, --token <token>', 'Authentication token')
  .requiredOption('-p, --project <project>', 'Project key')
  .option('--severity <severity>', 'Filter by severity')
  .option('--format <format>', 'Output format', 'json')
  .option('--branch <branch>', 'Branch name')
  .option('--pull-request <pull-request>', 'Pull request ID')
  .option('--all', 'Fetch all issues with pagination')
  .option('--page-size <page-size>', 'Page size for pagination', '500')
  .action(async (options) => {
    try {
      await issuesSearchCommand(options);
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

// Setup SonarQube integration for AI coding agent
program
  .command('onboard-agent <agent>')
  .description('Setup SonarQube integration for AI coding agent')
  .option('-s, --server <server>', 'SonarQube server URL')
  .option('-p, --project <project>', 'Project key')
  .option('-t, --token <token>', 'Existing authentication token')
  .option('-o, --org <org>', 'Organization key (for SonarCloud)')
  .option('--non-interactive', 'Non-interactive mode (no prompts)')
  .option('--skip-hooks', 'Skip hooks installation')
  .option('--hook-type <hook-type>', 'Hook type to install', 'prompt')
  .option('-v, --verbose', 'Verbose output')
  .action(async (agent, options) => {
    try {
      // Validate argument choices
      const validAgent = ['claude', 'gemini', 'codex'];
      if (!validAgent.includes(agent)) {
        console.error(`Error: Invalid agent. Must be one of: claude, gemini, codex`);
        process.exit(1);
      }

      await onboardAgentCommand(agent, options);
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

// Manage authentication tokens and credentials
const auth = program
  .command('auth')
  .description('Manage authentication tokens and credentials');

auth
  .command('login')
  .description('Save authentication token to keychain')
  .option('-s, --server <server>', 'SonarQube server URL (default is SonarCloud)')
  .option('-o, --org <org>', 'SonarCloud organization key (required for SonarCloud)')
  .option('-t, --with-token <with-token>', 'Token value (skips browser, non-interactive mode)')
  .action(async (options) => {
    try {
      await authLoginCommand(options);
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

auth
  .command('logout')
  .description('Remove authentication token from keychain')
  .option('-s, --server <server>', 'SonarQube server URL')
  .option('-o, --org <org>', 'SonarCloud organization key (required for SonarCloud)')
  .action(async (options) => {
    try {
      await authLogoutCommand(options);
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

auth
  .command('purge')
  .description('Remove all authentication tokens from keychain')
  .action(async () => {
    try {
      await authPurgeCommand();
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

program.parse();
