#!/usr/bin/env node

// Main CLI entry point
// Generated from cli-spec.yaml by Plop.js

import { Command } from 'commander';
import { VERSION } from './version.js';
import { runCommand } from './lib/run-command.js';

// Constants for argument validation
const VALID_AGENTS = ['claude', 'gemini', 'codex'] as const;

import { verifyCommand } from './commands/verify.js';
import { issuesSearchCommand } from './commands/issues.js';
import { onboardAgentCommand } from './commands/onboard-agent.js';
import { authLoginCommand, authLogoutCommand, authPurgeCommand, authListCommand } from './commands/auth.js';
import { preCommitInstallCommand, preCommitUninstallCommand } from './commands/pre-commit.js';
import { secretInstallCommand, secretStatusCommand, secretCheckCommand } from './commands/secret.js';

const program = new Command();

program
  .name('sonar')
  .description('SonarQube CLI')
  .version(VERSION, '-v, --version', 'display version for command');

// Analyze a file using SonarCloud A3S API
program
  .command('verify')
  .description('Analyze a file using SonarCloud A3S API')
  .requiredOption('--file <file>', 'File path to analyze')
  .option('--organization <organization>', 'Organization key (or use saved config)')
  .option('--project <project>', 'Project key')
  .option('-t, --token <token>', 'Authentication token (or use saved config)')
  .option('-b, --branch <branch>', 'Branch name')
  .option('--save-config', 'Save configuration for future use')
  .action(async (options) => {
    await runCommand(async () => {
      await verifyCommand(options);
    });
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
  .action(async (options) => {
    await runCommand(() => issuesSearchCommand(options));
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
  .option('--verbose', 'Verbose output')
  .action(async (agent, options) => {
    await runCommand(async () => {
      if (!VALID_AGENTS.includes(agent)) {
        throw new Error(`Invalid agent. Must be one of: ${VALID_AGENTS.join(', ')}`);
      }
      await onboardAgentCommand(agent, options);
    });
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
    await authLoginCommand(options);
  });

auth
  .command('logout')
  .description('Remove authentication token from keychain')
  .option('-s, --server <server>', 'SonarQube server URL')
  .option('-o, --org <org>', 'SonarCloud organization key (required for SonarCloud)')
  .action(async (options) => {
    await authLogoutCommand(options);
  });

auth
  .command('purge')
  .description('Remove all authentication tokens from keychain')
  .action(async () => {
    await authPurgeCommand();
  });

auth
  .command('list')
  .description('List saved authentication connections with token verification')
  .action(async () => {
    await authListCommand();
  });

// Manage pre-commit hooks for secrets detection
const preCommit = program
  .command('pre-commit')
  .description('Manage pre-commit hooks for secrets detection');

preCommit
  .command('install')
  .description('Install Sonar secrets pre-commit hook')
  .action(async () => {
    await preCommitInstallCommand();
  });

preCommit
  .command('uninstall')
  .description('Uninstall Sonar secrets pre-commit hook')
  .action(async () => {
    await preCommitUninstallCommand();
  });

// Manage sonar-secrets binary
const secret = program
  .command('secret')
  .description('Manage sonar-secrets binary');

secret
  .command('install')
  .description('Install sonar-secrets binary from GitHub releases')
  .option('--force', 'Force reinstall even if already installed')
  .action(async (options) => {
    await secretInstallCommand(options);
  });

secret
  .command('status')
  .description('Check sonar-secrets installation status')
  .action(async () => {
    await secretStatusCommand();
  });

secret
  .command('check')
  .description('Scan a file or stdin for hardcoded secrets')
  .option('--file <file>', 'File path to scan for secrets')
  .option('--stdin', 'Read from standard input instead of a file')
  .action(async (options) => {
    await runCommand(() => secretCheckCommand(options));
  });


const AUTH_ARGC_WITHOUT_SUBCOMMAND = 3;

// Handle `sonar auth` without subcommand (defaults to login)
if (process.argv.length === AUTH_ARGC_WITHOUT_SUBCOMMAND && process.argv[2] === 'auth') {
  // User ran `sonar auth` without subcommand - inject 'login' subcommand
  process.argv.splice(AUTH_ARGC_WITHOUT_SUBCOMMAND, 0, 'login');
}

program.parse();
