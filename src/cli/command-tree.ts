/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
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
import { type Command, Help, Option } from 'commander';
import { SonarCommand } from './commands/_common/sonar-command.js';
import { getBanner, getCustomRootHelp } from './root-help.js';
import {
  listIssues,
  VALID_SEVERITIES,
  VALID_STATUSES,
  type ListIssuesOptions,
} from './commands/list/issues';
import { listProjects, type ListProjectsOptions } from './commands/list/projects';
import { authLogin, type AuthLoginOptions } from './commands/auth/login';
import { authLogout } from './commands/auth/logout';
import { authPurge } from './commands/auth/purge';
import { authStatus } from './commands/auth/status';
import { integrateClaude, type IntegrateClaudeOptions } from './commands/integrate/claude';
import { integrateGit, type IntegrateGitOptions } from './commands/integrate/git/index';
import { analyzeSecrets, type AnalyzeSecretsOptions } from './commands/analyze/secrets';
import { analyzeSqaa, type AnalyzeSqaaOptions } from './commands/analyze/sqaa';
import { flushTelemetry, storeEvent, TELEMETRY_FLUSH_MODE_ENV } from '../telemetry';
import { configureTelemetry, type ConfigureTelemetryOptions } from './commands/config/telemetry';
import { selfUpdate, type SelfUpdateOptions } from './commands/self-update/self-update';
import { parseInteger } from './commands/_common/parsing';
import { MAX_PAGE_SIZE } from '../sonarqube/projects';
import { apiCommand, apiExtraHelpText, type ApiCommandOptions } from './commands/api/api';
import { GENERIC_HTTP_METHODS } from '../sonarqube/client';

const DEFAULT_PAGE_SIZE = MAX_PAGE_SIZE;

export const COMMAND_TREE = new SonarCommand();

COMMAND_TREE.name('sonar')
  .description('SonarQube CLI')
  .version(VERSION, '-v, --version', 'display version for command')
  .enablePositionalOptions()
  .configureHelp({
    formatHelp: (cmd, helper) => {
      if (!cmd.parent) {
        return getCustomRootHelp();
      }
      return getBanner(VERSION) + '\n' + Help.prototype.formatHelp.call(helper, cmd, helper);
    },
  })
  .anonymousAction(function (this: Command) {
    this.outputHelp();
  });

COMMAND_TREE.command('api')
  .argument(
    '<method>',
    `HTTP method (${GENERIC_HTTP_METHODS.map((m) => m.toLowerCase()).join(', ')})`,
  )
  .argument(
    '<endpoint>',
    'API endpoint path. Must start with "/", and can contain query parameters.',
  )
  .option(
    '-d, --data <data>',
    'JSON string for request body. The tool will automatically format as either form data or JSON body.',
  )
  .option('-v, --verbose', 'Print request and response details for debugging.')
  .description('Make authenticated API requests to SonarQube')
  .addHelpText('after', apiExtraHelpText())
  .authenticatedAction((auth, method: string, endpoint: string, options: ApiCommandOptions) =>
    apiCommand(auth, method, endpoint, options),
  );

// Setup SonarQube integration for AI coding agent
const integrateCommand = COMMAND_TREE.command('integrate').description(
  'Setup SonarQube integration for AI coding agents, git and others.',
);

integrateCommand
  .command('claude')
  .description(
    'Setup SonarQube integration for Claude Code. This will install secrets scanning hooks, and configure SonarQube MCP Server.',
  )
  .option('-p, --project <project>', 'Project key')
  .option('--non-interactive', 'Non-interactive mode (no prompts)')
  .option(
    '-g, --global',
    'Install hooks and config globally to ~/.claude instead of project directory',
  )
  .authenticatedAction((auth, options: IntegrateClaudeOptions) => integrateClaude(options, auth));

integrateCommand
  .command('git')
  .description(
    'Install a git hook that scans staged files for secrets before each commit (pre-commit) or scans committed files for secrets before each push (pre-push).',
  )
  .option(
    '--hook <type>',
    'Hook to install: pre-commit (scan staged files) or pre-push (scan files in unpushed commits)',
  )
  .option('--force', 'Overwrite existing hook if it is not from sonar integrate git')
  .option('--non-interactive', 'Non-interactive mode (no prompts)')
  .option(
    '--global',
    'Install hook globally for all repositories (sets git config --global core.hooksPath)',
  )
  .authenticatedAction((_auth, options: IntegrateGitOptions) => integrateGit(options));

// List Sonar resources
const list = COMMAND_TREE.command('list').description('List Sonar resources');

const pageOption = new Option('--page <page>', 'Page number').default(1).argParser(parseInteger);
const pageSizeOption = new Option('--page-size <page-size>', 'Page size (1-500)')
  .default(DEFAULT_PAGE_SIZE)
  .argParser(parseInteger);
list
  .command('issues')
  .description('Search for issues in SonarQube')
  .requiredOption('-p, --project <project>', 'Project key')
  .option(
    '--status <status>',
    `Filter by status (comma-separated list of: ${VALID_STATUSES.join(', ')})`,
  )
  .option(
    '--severity <severity>',
    `Filter by severity (comma-separated list of: ${VALID_SEVERITIES.join(', ')})`,
  )
  .option('--format <format>', 'Output format', 'json')
  .option('--branch <branch>', 'Branch name')
  .option('--pull-request <pull-request>', 'Pull request ID')
  .addOption(pageSizeOption)
  .addOption(pageOption)
  .authenticatedAction((auth, options: ListIssuesOptions) => listIssues(options, auth));

list
  .command('projects')
  .description('Search for projects in SonarQube')
  .option('-q, --query <query>', 'Search query to filter projects by name or key')
  .addOption(pageOption)
  .addOption(pageSizeOption)
  .authenticatedAction((auth, options: ListProjectsOptions) => listProjects(options, auth));

// Manage authentication tokens and credentials
const auth = COMMAND_TREE.command('auth').description(
  'Manage authentication tokens and credentials',
);

auth
  .command('login')
  .description('Save authentication token to keychain')
  .option('-s, --server <server>', 'SonarQube URL (default is SonarQube https://sonarcloud.io)')
  .option('-o, --org <org>', 'SonarQube Cloud organization key (required for SonarQube Cloud)')
  .option('-t, --with-token <with-token>', 'Token value (skips browser, non-interactive mode)')
  .anonymousAction((options: AuthLoginOptions) => authLogin(options));

auth
  .command('logout')
  .description('Remove active connection token from keychain')
  .anonymousAction(() => authLogout());

auth
  .command('purge')
  .description('Remove all authentication tokens from keychain')
  .anonymousAction(() => authPurge());

auth
  .command('status')
  .description('Show active authentication connection with token verification')
  .anonymousAction(() => authStatus());

// Analyze code for security issues
const analyze = COMMAND_TREE.command('analyze')
  .description('Analyze code for security issues')
  .enablePositionalOptions()
  .anonymousAction(function (this: Command) {
    this.outputHelp();
  });

analyze
  .command('secrets')
  .description('Scan files or stdin for hardcoded secrets')
  .argument('[paths...]', 'File or directory paths to scan for secrets')
  .option('--stdin', 'Read from standard input instead of paths')
  .authenticatedAction((auth, paths: string[], options: AnalyzeSecretsOptions) =>
    analyzeSecrets({ paths: Array.isArray(paths) ? paths : [], stdin: options.stdin }, auth),
  );

analyze
  .command('sqaa')
  .description('Run SQAA server-side analysis on a file (SonarQube Cloud only)')
  .requiredOption('--file <file>', 'File path to analyze')
  .option('--branch <branch>', 'Branch name for analysis context')
  .option(
    '-p, --project <project>',
    'SonarQube Cloud project key (overrides auto-detected project)',
  )
  .authenticatedAction((auth, options: AnalyzeSqaaOptions, cmd: Command) =>
    analyzeSqaa(options, auth, cmd),
  );

COMMAND_TREE.command('verify')
  .description('Analyze a file for issues')
  .requiredOption('--file <file>', 'File path to analyze')
  .option('--branch <branch>', 'Branch name for analysis context')
  .option(
    '-p, --project <project>',
    'SonarQube Cloud project key (overrides auto-detected project)',
  )
  .authenticatedAction((auth, options: AnalyzeSqaaOptions, cmd: Command) =>
    analyzeSqaa(options, auth, cmd),
  );

// Configure things related to the CLI
const configure = COMMAND_TREE.command('config').description('Configure CLI settings');

configure
  .command('telemetry')
  .description('Configure telemetry settings')
  .option('--enabled', 'Enable collection of anonymous usage statistics')
  .option('--disabled', 'Disable collection of anonymous usage statistics')
  .anonymousAction((options: ConfigureTelemetryOptions) => configureTelemetry(options));

// Update the CLI to the latest version
COMMAND_TREE.command('self-update')
  .description('Update sonar CLI to the latest version')
  .option('--status', 'Check for a newer version without installing')
  .option('--force', 'Install the latest version even if already up to date')
  .anonymousAction((options: SelfUpdateOptions) => selfUpdate(options));

// Hidden flush command — only registered when running as a telemetry worker.
if (process.env[TELEMETRY_FLUSH_MODE_ENV]) {
  COMMAND_TREE.command('flush-telemetry', { hidden: true }).anonymousAction(flushTelemetry);
}

// Collect a telemetry event after every command action.
COMMAND_TREE.hook('postAction', async (_thisCommand, actionCommand) => {
  await storeEvent(actionCommand, (process.exitCode ?? 0) === 0);
});
