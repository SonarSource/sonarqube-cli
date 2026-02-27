#!/usr/bin/env node

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

// Main CLI entry point
// Generated from cli-spec.yaml by Plop.js

import { version as VERSION } from '../package.json';
import { Command } from 'commander';
import { runCommand } from './lib/run-command.js';
import logger from './lib/logger.js';
import { issuesSearchCommand } from './commands/issues.js';
import {
  authLoginCommand,
  authLogoutCommand,
  authPurgeCommand,
  authStatusCommand,
} from './commands/auth.js';
import { secretInstallCommand, secretStatusCommand } from './commands/secret.js';
import { integrateCommand } from './commands/integrate.js';
import { analyzeSecretsCommand } from './commands/analyze.js';
import { projectsSearchCommand } from './commands/projects.js';
import { flushTelemetry, storeEvent, TELEMETRY_FLUSH_MODE_ENV } from './telemetry';
import { configureTelemetry, type ConfigureTelemetryOptions } from './commands/config.js';

// Constants for argument validation
const VALID_TOOLS = ['claude', 'gemini', 'codex'] as const;
const AUTH_ARGC_WITHOUT_SUBCOMMAND = 3;
const ANALYZE_ARG_INDEX = 2;
const ANALYZE_SUBCOMMAND_INDEX = 3;

const program = new Command();

program
  .name('sonar')
  .description('SonarQube CLI')
  .version(VERSION, '-v, --version', 'display version for command');

// Install Sonar tools
const install = program.command('install').description('Install Sonar tools');

install
  .command('secrets')
  .description('Install sonar-secrets binary from binaries.sonarsource.com')
  .option('--force', 'Force reinstall even if already installed')
  .option('--status', 'Check installation status instead of installing')
  .action(async (options) => {
    if (options.status) {
      await secretStatusCommand();
    } else {
      await secretInstallCommand(options);
    }
  });

// Setup SonarQube integration for AI coding agent
program
  .command('integrate <tool>')
  .description(
    'Setup SonarQube integration for various tools, like AI coding agents, git and others',
  )
  .option('-s, --server <server>', 'SonarQube server URL')
  .option('-p, --project <project>', 'Project key')
  .option('-t, --token <token>', 'Existing authentication token')
  .option('-o, --org <org>', 'Organization key (for SonarCloud)')
  .option('--non-interactive', 'Non-interactive mode (no prompts)')
  .option('--skip-hooks', 'Skip hooks installation')
  .option(
    '-g, --global',
    'Install hooks and config globally to ~/.claude instead of project directory',
  )
  .action(async (agent, options) => {
    await runCommand(async () => {
      if (!VALID_TOOLS.includes(agent)) {
        throw new Error(`Invalid tool. Must be one of: ${VALID_TOOLS.join(', ')}`);
      }
      await integrateCommand(agent, options);
    });
  });

// List Sonar resources
const list = program.command('list').description('List Sonar resources');

list
  .command('issues')
  .description('Search for issues in SonarQube')
  .option('-s, --server <server>', 'SonarQube server URL')
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

list
  .command('projects')
  .description('Search for projects in SonarQube')
  .option('-q, --query <query>', 'Search query to filter projects by name or key')
  .option('-p, --page <page>', 'Page number', '1')
  .option('--page-size <page-size>', 'Page size (1-500)', '500')
  .action(async (options) => {
    await runCommand(async () => {
      await projectsSearchCommand(options);
    });
  });

// Manage authentication tokens and credentials
const auth = program.command('auth').description('Manage authentication tokens and credentials');

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
  .command('status')
  .description('Show active authentication connection with token verification')
  .action(async () => {
    await authStatusCommand();
  });

// Analyze code for security issues
const analyze = program.command('analyze').description('Analyze code for security issues');

analyze
  .command('secrets')
  .description('Scan a file or stdin for hardcoded secrets')
  .option('--file <file>', 'File path to scan for secrets')
  .option('--stdin', 'Read from standard input instead of a file')
  .action(async (options) => {
    await runCommand(() => analyzeSecretsCommand(options));
  });

// Configure things related to the CLI
const configure = program.command('config').description('Configure CLI settings');

configure
  .command('telemetry')
  .description('Configure telemetry settings')
  .option('--enabled', 'Enable collection of anonymous usage statistics')
  .option('--disabled', 'Disable collection of anonymous usage statistics')
  .action((options: ConfigureTelemetryOptions) => runCommand(() => configureTelemetry(options)));

// Hidden flush command — only registered when running as a telemetry worker.
if (process.env[TELEMETRY_FLUSH_MODE_ENV]) {
  program.command('flush-telemetry', { hidden: true }).action(flushTelemetry);
}

// Collect a telemetry event after every command action.
program.hook('postAction', async (_thisCommand, actionCommand) => {
  await storeEvent(actionCommand, (process.exitCode ?? 0) === 0);
});

// Handle `sonar auth` without subcommand (defaults to login)
if (process.argv.length === AUTH_ARGC_WITHOUT_SUBCOMMAND && process.argv[2] === 'auth') {
  // User ran `sonar auth` without subcommand - inject 'login' subcommand
  process.argv.splice(AUTH_ARGC_WITHOUT_SUBCOMMAND, 0, 'login');
}

// Handle `sonar analyze` without subcommand (defaults to secrets)
if (process.argv[ANALYZE_ARG_INDEX] === 'analyze') {
  const nextArg = process.argv[ANALYZE_SUBCOMMAND_INDEX];
  if (!nextArg || nextArg.startsWith('-')) {
    process.argv.splice(ANALYZE_SUBCOMMAND_INDEX, 0, 'secrets');
  }
}

program.exitOverride((err) => {
  logger.error('Error: ' + err.message);
  process.exit(1);
});
program.parse();
