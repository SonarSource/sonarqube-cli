#!/usr/bin/env node

// Main CLI entry point
// Generated from cli-spec.yaml by Plop.js

import { Command } from 'commander';
import { VERSION } from './version.js';
import logger from './lib/logger.js';
import { verifyCommand } from './commands/verify.js';
import { issuesSearchCommand } from './commands/issues.js';
import { onboardAgentCommand } from './commands/onboard-agent.js';
import { authLoginCommand, authLogoutCommand, authPurgeCommand, authListCommand } from './commands/auth.js';
import { preCommitInstallCommand, preCommitUninstallCommand } from './commands/pre-commit.js';

const program = new Command();

program
  .name('sonar')
  .description('SonarQube CLI for AI coding agents')
  .version(VERSION, '-v, --version', 'output the current version');

// Analyze a file using SonarCloud A3S API
program
  .command('verify')
  .description('Analyze a file using SonarCloud A3S API')
  .requiredOption('--file <file>', 'File path to analyze')
  .option('--organization <organization-key>', 'Organization key (or use saved config)')
  .option('--project <project-key>', 'Project key (or use saved config)')
  .option('-t, --token <token>', 'Authentication token (or use saved config)')
  .option('-b, --branch <branch>', 'Branch name')
  .option('--save-config', 'Save configuration for future use')
  .action(async (options, cmd) => {
    try {
      await verifyCommand(options);
    } catch (error) {
      logger.error('Error:', (error as Error).message);
      logger.info('');
      cmd.help();
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
  .option('--all', 'Fetch all issues with pagination', 'false')
  .option('--page-size <page-size>', 'Page size for pagination', '500')
  .action(async (options, cmd) => {
    try {
      await issuesSearchCommand(options);
    } catch (error) {
      logger.error('Error:', (error as Error).message);
      logger.info('');
      cmd.help();
    }
  });

// Setup SonarQube integration for AI coding agent
program
  .command('onboard-agent [agent]')
  .description('Setup SonarQube integration for AI coding agent')
  .option('-s, --server <server>', 'SonarQube server URL')
  .option('-p, --project <project>', 'Project key')
  .option('-t, --token <token>', 'Existing authentication token')
  .option('-o, --org <org>', 'Organization key (for SonarCloud)')
  .option('--non-interactive', 'Non-interactive mode (no prompts)')
  .option('--skip-hooks', 'Skip hooks installation', 'false')
  .option('--hook-type <hook-type>', 'Hook type to install', 'prompt')
  .option('-v, --verbose', 'Verbose output', 'false')
  .action(async (agent, options, cmd) => {
    try {
      // Validate that agent is provided
      if (!agent) {
        logger.error('Error: Missing required argument <agent>');
        logger.info('');
        cmd.help();
        return;
      }

      // Validate argument choices
      const validAgent = ['claude', 'gemini', 'codex'];
      if (!validAgent.includes(agent)) {
        logger.error(`Error: Invalid agent. Must be one of: claude, gemini, codex`);
        logger.info('');
        cmd.help();
        return;
      }

      await onboardAgentCommand(agent, options);
    } catch (error) {
      logger.error('Error:', (error as Error).message);
      logger.info('');
      cmd.help();
    }
  });

// Manage authentication tokens and credentials
const auth = program
  .command('auth')
  .description('Manage authentication tokens and credentials')
  .action(async (options, cmd) => {
    // If no subcommand provided, default to login
    if (cmd.args.length === 0) {
      try {
        await authLoginCommand(options);
      } catch (error) {
        logger.error('Error:', (error as Error).message);
        process.exit(1);
      }
    }
  });

auth
  .command('login')
  .description('Save authentication token to keychain')
  .option('-s, --server <server>', 'SonarQube server URL (default is SonarCloud)')
  .option('-o, --org <org>', 'SonarCloud organization key (required for SonarCloud)')
  .option('-t, --with-token <with-token>', 'Token value (skips browser, non-interactive mode)')
  .action(async (options, cmd) => {
    try {
      await authLoginCommand(options);
    } catch (error) {
      logger.error('Error:', (error as Error).message);
      logger.info('');
      cmd.help();
    }
  });

auth
  .command('logout')
  .description('Remove authentication token from keychain')
  .option('-s, --server <server>', 'SonarQube server URL')
  .option('-o, --org <org>', 'SonarCloud organization key (required for SonarCloud)')
  .action(async (options, cmd) => {
    try {
      await authLogoutCommand(options);
    } catch (error) {
      logger.error('Error:', (error as Error).message);
      logger.info('');
      cmd.help();
    }
  });

auth
  .command('purge')
  .description('Remove all authentication tokens from keychain')
  .action(async (options, cmd) => {
    try {
      await authPurgeCommand();
    } catch (error) {
      logger.error('Error:', (error as Error).message);
      logger.info('');
      cmd.help();
    }
  });

auth
  .command('list')
  .description('List saved authentication connections with token verification')
  .action(async (options, cmd) => {
    try {
      await authListCommand();
    } catch (error) {
      logger.error('Error:', (error as Error).message);
      logger.info('');
      cmd.help();
    }
  });

// Manage pre-commit hooks for secrets detection
const preCommit = program
  .command('pre-commit')
  .description('Manage pre-commit hooks for secrets detection');

preCommit
  .command('install')
  .description('Install Sonar secrets pre-commit hook')
  .action(async (options, cmd) => {
    try {
      await preCommitInstallCommand();
    } catch (error) {
      logger.error('Error:', (error as Error).message);
      logger.info('');
      cmd.help();
    }
  });

preCommit
  .command('uninstall')
  .description('Uninstall Sonar secrets pre-commit hook')
  .action(async (options, cmd) => {
    try {
      await preCommitUninstallCommand();
    } catch (error) {
      logger.error('Error:', (error as Error).message);
      logger.info('');
      cmd.help();
    }
  });

program.parse();
