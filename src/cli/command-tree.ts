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

import { version as VERSION } from '../../package.json';
import { Argument, Command, Option } from 'commander';
import { runCommand } from '../lib/run-command';
import {
  listIssues,
  type ListIssuesOptions,
  listProjects,
  type ListProjectsOptions,
} from './commands/list';
import {
  authLogin,
  type AuthLoginOptions,
  authLogout,
  type AuthLogoutOptions,
  authPurge,
  authStatus,
} from './commands/auth';
import { installSecrets, type InstallSecretsOptions } from './commands/install';
import { integrate, type IntegrateOptions, VALID_TOOLS } from './commands/integrate';
import { analyzeSecrets, type AnalyzeSecretsOptions } from './commands/analyze';
import { flushTelemetry, storeEvent, TELEMETRY_FLUSH_MODE_ENV } from '../telemetry';
import { configureTelemetry, type ConfigureTelemetryOptions } from './commands/config';
import { parseInteger } from './commands/common/parsing';
import { MAX_PAGE_SIZE } from '../sonarqube/projects';

// Constants for argument validation
const AUTH_ARGC_WITHOUT_SUBCOMMAND = 3;
const ANALYZE_ARG_INDEX = 2;
const ANALYZE_SUBCOMMAND_INDEX = 3;

const DEFAULT_PAGE_SIZE = MAX_PAGE_SIZE;

export const COMMAND_TREE = new Command();

COMMAND_TREE.name('sonar')
  .description('SonarQube CLI')
  .version(VERSION, '-v, --version', 'display version for command');

// Install Sonar tools
const install = COMMAND_TREE.command('install').description('Install Sonar tools');

install
  .command('secrets')
  .description('Install sonar-secrets binary from https://binaries.sonarsource.com')
  .option('--force', 'Force reinstall even if already installed')
  .option('--status', 'Check installation status instead of installing')
  .action((options: InstallSecretsOptions) => runCommand(() => installSecrets(options)));

// Setup SonarQube integration for AI coding agent
COMMAND_TREE.command('integrate')
  .addArgument(
    new Argument('<tool>', 'AI coding agent or tool to integrate with').choices([...VALID_TOOLS]),
  )
  .description(
    'Setup SonarQube integration (hooks, config...) for various tools, like AI coding agents, git and others',
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
  .action((tool: string, options: IntegrateOptions) => runCommand(() => integrate(tool, options)));

// List Sonar resources
const list = COMMAND_TREE.command('list').description('List Sonar resources');

const pageSizeOption = new Option('--page-size <page-size>', 'Page size (1-500)')
  .default(DEFAULT_PAGE_SIZE)
  .argParser(parseInteger);

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
  .option('--all', 'Fetch all issues with pagination')
  .addOption(pageSizeOption)
  .action((options: ListIssuesOptions) => runCommand(() => listIssues(options)));

list
  .command('projects')
  .description('Search for projects in SonarQube')
  .option('-q, --query <query>', 'Search query to filter projects by name or key')
  .addOption(new Option('-p, --page <page>', 'Page number').default(1).argParser(parseInteger))
  .addOption(pageSizeOption)
  .action((options: ListProjectsOptions) => runCommand(() => listProjects(options)));

// Manage authentication tokens and credentials
const auth = COMMAND_TREE.command('auth').description(
  'Manage authentication tokens and credentials',
);

auth
  .command('login')
  .description('Save authentication token to keychain')
  .option('-s, --server <server>', 'SonarQube server URL (default is SonarCloud)')
  .option('-o, --org <org>', 'SonarCloud organization key (required for SonarCloud)')
  .option('-t, --with-token <with-token>', 'Token value (skips browser, non-interactive mode)')
  .action((options: AuthLoginOptions) => runCommand(() => authLogin(options)));

auth
  .command('logout')
  .description('Remove authentication token from keychain')
  .option('-s, --server <server>', 'SonarQube server URL')
  .option('-o, --org <org>', 'SonarCloud organization key (required for SonarCloud)')
  .action((options: AuthLogoutOptions) => runCommand(() => authLogout(options)));

auth
  .command('purge')
  .description('Remove all authentication tokens from keychain')
  .action(() => runCommand(() => authPurge()));

auth
  .command('status')
  .description('Show active authentication connection with token verification')
  .action(() => runCommand(() => authStatus()));

// Analyze code for security issues
const analyze = COMMAND_TREE.command('analyze').description('Analyze code for security issues');

analyze
  .command('secrets')
  .description('Scan a file or stdin for hardcoded secrets')
  .option('--file <file>', 'File path to scan for secrets')
  .option('--stdin', 'Read from standard input instead of a file')
  .action((options: AnalyzeSecretsOptions) => runCommand(() => analyzeSecrets(options)));

// Configure things related to the CLI
const configure = COMMAND_TREE.command('config').description('Configure CLI settings');

configure
  .command('telemetry')
  .description('Configure telemetry settings')
  .option('--enabled', 'Enable collection of anonymous usage statistics')
  .option('--disabled', 'Disable collection of anonymous usage statistics')
  .action((options: ConfigureTelemetryOptions) => runCommand(() => configureTelemetry(options)));

// Hidden flush command — only registered when running as a telemetry worker.
if (process.env[TELEMETRY_FLUSH_MODE_ENV]) {
  COMMAND_TREE.command('flush-telemetry', { hidden: true }).action(flushTelemetry);
}

// Collect a telemetry event after every command action.
COMMAND_TREE.hook('postAction', async (_thisCommand, actionCommand) => {
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
