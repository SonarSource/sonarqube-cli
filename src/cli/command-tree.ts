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

import { type Command, Help, Option } from 'commander';

import { version as VERSION } from '../../package.json';
import { loadState } from '../lib/repository/state-repository';
import { initSentry } from '../lib/sentry';
import { GENERIC_HTTP_METHODS } from '../sonarqube/client';
import { MAX_PAGE_SIZE } from '../sonarqube/projects';
import { flushTelemetry, storeEvent, TELEMETRY_FLUSH_MODE_ENV } from '../telemetry';
import { warn } from '../ui';
import { parseInteger } from './commands/_common/parsing';
import { SonarCommand } from './commands/_common/sonar-command.js';
import { analyzeAll, type AnalyzeAllOptions } from './commands/analyze/analyze-all';
import {
  analyzeDependencyRisks,
  type AnalyzeDependencyRisksOptions,
  VALID_FORMATS as DEPENDENCY_RISKS_FORMATS,
} from './commands/analyze/dependency-risks';
import { analyzeSecrets, type AnalyzeSecretsOptions } from './commands/analyze/secrets';
import {
  analyzeSqaa,
  type AnalyzeSqaaOptions,
  VALID_FORMATS as SQAA_FORMATS,
} from './commands/analyze/sqaa';
import { apiCommand, type ApiCommandOptions, apiExtraHelpText } from './commands/api/api';
import { authLogin, type AuthLoginOptions } from './commands/auth/login';
import { authLogout } from './commands/auth/logout';
import { authPurge } from './commands/auth/purge';
import { authStatus } from './commands/auth/status';
import { configureTelemetry, type ConfigureTelemetryOptions } from './commands/config/telemetry';
import { runContextPassthrough } from './commands/context';
import {
  agentPostToolUse,
  type AgentPostToolUseOptions,
} from './commands/hook/agent-post-tool-use';
import { agentPromptSubmit } from './commands/hook/agent-prompt-submit';
import { claudePreToolUse } from './commands/hook/claude-pre-tool-use';
import { codexPromptSubmit } from './commands/hook/codex-prompt-submit';
import { copilotPreToolUse } from './commands/hook/copilot-pre-tool-use';
import { gitPreCommit } from './commands/hook/git-pre-commit';
import { gitPrePush } from './commands/hook/git-pre-push';
import type { IntegrateAgentOptions } from './commands/integrate/_common/types';
import { integrateClaude } from './commands/integrate/claude';
import { integrateCodex } from './commands/integrate/codex';
import { integrateCopilot } from './commands/integrate/copilot';
import { integrateGit, type IntegrateGitOptions } from './commands/integrate/git';
import {
  listIssues,
  type ListIssuesOptions,
  VALID_FORMATS,
  VALID_SEVERITIES,
  VALID_STATUSES,
} from './commands/list/issues';
import { listProjects, type ListProjectsOptions } from './commands/list/projects';
import { remediate, type RemediateOptions } from './commands/remediate';
import { runMcp } from './commands/run/mcp.js';
import { selfUpdate, type SelfUpdateOptions } from './commands/self-update/self-update';
import { getBanner, getCustomRootHelp } from './root-help.js';

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

// Manage authentication tokens and credentials
const auth = COMMAND_TREE.command('auth').description(
  'Manage authentication tokens and credentials',
);

auth
  .command('login')
  .description('Save authentication token to keychain')
  .option(
    '-s, --server <server>',
    'SonarQube Server URL, SonarQube Cloud EU (https://sonarcloud.io), or SonarQube Cloud US (https://sonarqube.us). Defaults to SonarQube Cloud EU.',
  )
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

const projectKeyExtraHelp = `
Instead of providing an explicit --project, you can add sonar.projectKey to sonar-project.properties at the repository root.
Alternatively, add SonarQube for IDE shared binding JSON under .sonarlint/ (for example .sonarlint/connectedMode.json) that includes projectKey.
`;
integrateCommand
  .command('claude')
  .description(
    'Setup SonarQube integration for Claude Code. This will install secrets scanning hooks, configure SonarQube Agentic Analysis and MCP Server.',
  )
  .option('-p, --project <project>', 'Project key. Ignored when --global is used.')
  .option('--non-interactive', 'Non-interactive mode (no prompts)')
  .option(
    '-g, --global',
    'Install hooks and config globally to ~/.claude instead of project directory',
  )
  .option('--skip-context', 'Skip the sonar-context-augmentation install/init/skill step')
  .addHelpText('after', projectKeyExtraHelp)
  .authenticatedAction((auth, options: IntegrateAgentOptions) => integrateClaude(options, auth));

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

integrateCommand
  .command('copilot')
  .description(
    'Setup SonarQube integration for Copilot. This will install secrets scanning hooks, configure SonarQube Agentic Analysis and MCP Server.',
  )
  .option(
    '-g, --global',
    'Install hooks and config globally to ~/.copilot instead of project directory',
  )
  .option('-p, --project <project>', 'Project key. Mutually exclusive with --global.')
  .option('--skip-context', 'Skip the sonar-context-augmentation install/init/skill step')
  .addHelpText('after', projectKeyExtraHelp)
  .authenticatedAction((auth, options: IntegrateAgentOptions) => integrateCopilot(auth, options));

// `sonar context` — passthrough wrapper for sonar-context-augmentation.
// Forwards arguments verbatim to the locally-installed CAG binary; install via
// `sonar integrate claude` or `sonar integrate copilot`.
COMMAND_TREE.command('context')
  .description('Run Context Augmentation actions (analysis context for AI agents)')
  .argument('[action]', 'Action forwarded to sonar-context-augmentation')
  .argument('[args...]', 'Additional arguments forwarded to sonar-context-augmentation')
  .helpOption(false)
  .passThroughOptions()
  .allowUnknownOption()
  .anonymousAction((action: string | undefined, args: string[]) =>
    runContextPassthrough(action, args),
  );

integrateCommand
  .command('codex')
  .description(
    'Setup SonarQube integration for Codex. This will install a UserPromptSubmit hook that scans prompts for secrets before they are sent.',
  )
  .option(
    '-g, --global',
    'Install hook and config globally to ~/.codex instead of project directory',
  )
  .option('-p, --project <project>', 'Project key. Mutually exclusive with --global.')
  .addHelpText('after', projectKeyExtraHelp)
  .authenticatedAction((auth, options: IntegrateAgentOptions) => integrateCodex(options, auth));

// List Sonar resources
const list = COMMAND_TREE.command('list').description('List issues and projects from SonarQube');

const pageOption = new Option('--page <page>', 'Page number').default(1).argParser(parseInteger);
const pageSizeOption = new Option('--page-size <page-size>', 'Page size (1-500)')
  .default(DEFAULT_PAGE_SIZE)
  .argParser(parseInteger);
const listIssuesFormatOption = new Option('--format <format>', 'Output format')
  .choices(VALID_FORMATS)
  .default('json');
list
  .command('issues')
  .description('Search for issues in SonarQube')
  .requiredOption('-p, --project <project>', 'Project key')
  .option(
    '--statuses <statuses>',
    `Filter by status (comma-separated list of: ${VALID_STATUSES.join(', ')})`,
  )
  .option(
    '--severities <severities>',
    `Filter by severity (comma-separated list of: ${VALID_SEVERITIES.join(', ')})`,
  )
  .addOption(listIssuesFormatOption)
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

// Trigger AI remediation for eligible issues (SonarQube Cloud only)
COMMAND_TREE.command('remediate')
  .description('Trigger AI agent remediation for eligible issues (SonarQube Cloud only)')
  .option(
    '-p, --project <project>',
    'SonarQube Cloud project key (overrides auto-detected project)',
  )
  .option(
    '--issues <issueIds>',
    'Comma-separated issue keys to remediate non-interactively (max 20). Required when stdin is not a TTY.',
  )
  .authenticatedAction((auth, options: RemediateOptions) => remediate(options, auth));

// Analyze code for quality and security issues
const analyze = COMMAND_TREE.command('analyze')
  .description('Analyze code for quality and security issues')
  .enablePositionalOptions();

analyze
  .command('secrets')
  .description('Scan files or stdin for hardcoded secrets')
  .argument('[paths...]', 'File or directory paths to scan for secrets')
  .option('--stdin', 'Read from standard input instead of paths')
  .authenticatedAction((auth, paths: string[], options: AnalyzeSecretsOptions) =>
    analyzeSecrets({ paths: Array.isArray(paths) ? paths : [], stdin: options.stdin }, auth),
  );

// Shared option set for `analyze agentic` and `verify`.
const sqaaFormatOption = new Option('--format <format>', 'Output format')
  .choices(SQAA_FORMATS)
  .default('text');

// Options shared between the bare `analyze` command and its `agentic` subcommand.
// `--branch` and `--project` are intentionally excluded from the bare command.
function applyBaseAgenticOptions(cmd: SonarCommand): SonarCommand {
  return cmd
    .option('--file <file>', 'Analyze a single file (skips change set detection)')
    .option('--staged', 'Analyze staged files only (git diff --cached)')
    .option('--base <ref>', 'Analyze files changed vs a branch or ref (e.g. main)')
    .option('--force', 'Skip the large change set confirmation prompt')
    .addOption(sqaaFormatOption);
}

function applySqaaOptions(cmd: SonarCommand): SonarCommand {
  return applyBaseAgenticOptions(cmd)
    .option('--branch <branch>', 'Branch name for analysis context')
    .option(
      '-p, --project <project>',
      'SonarQube Cloud project key (overrides auto-detected project)',
    )
    .authenticatedAction((auth, options: AnalyzeSqaaOptions, innerCmd: Command) =>
      analyzeSqaa(options, auth, innerCmd),
    );
}

// Default action for `sonar analyze` (no subcommand): run all analyses (secrets + agentic).
applyBaseAgenticOptions(analyze).authenticatedAction(
  (auth, options: AnalyzeAllOptions, innerCmd: Command) => analyzeAll(options, auth, innerCmd),
);

const dependencyRisksFormatOption = new Option('--format <format>', 'Output format')
  .choices(DEPENDENCY_RISKS_FORMATS)
  .default('table');

const dependencyRisksStatusFilterOption = new Option(
  '--statuses <statuses>',
  'Filter issues by status\n' +
    '\n' +
    '  Raw:       new | open | confirm | accept | safe | fixed\n' +
    '  Presets:   active | to_fix | all\n' +
    '    active:  new, open, confirm\n' +
    '    to_fix:  new, open, confirm, accept\n' +
    '    all:     new, open, confirm, accept, safe, fixed\n' +
    '\n' +
    'Presets and raw statuses can be combined; the resulting set is the union.\n' +
    '\n' +
    'Examples:\n' +
    '    --statuses active\n' +
    '    --statuses new,confirm\n' +
    '    --statuses active,safe\n',
).default('active');

analyze
  .command('dependency-risks')
  .description('Analyze project dependencies for security and license risks')
  .requiredOption('-p, --project <project>', 'Project key')
  .addOption(dependencyRisksFormatOption)
  .addOption(dependencyRisksStatusFilterOption)
  .authenticatedAction((auth, options: AnalyzeDependencyRisksOptions) =>
    analyzeDependencyRisks(options, auth),
  );

applySqaaOptions(
  analyze.command('agentic').description('Run server-side Agentic Analysis (SonarQube Cloud only)'),
);

// `verify` is deprecated in favour of `sonar analyze`.
const verifyCmd = applySqaaOptions(
  COMMAND_TREE.command('verify').description(
    "Run server-side SonarQube Agentic Analysis (deprecated — use 'sonar analyze' instead)",
  ),
);
verifyCmd.hook('preAction', () => {
  warn(
    "sonar verify is deprecated and will be removed in a future major version. Use 'sonar analyze' instead.",
  );
});

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

const runCommand = COMMAND_TREE.command('run', { hidden: true }).description(
  'Run SonarQube services',
);

// Hidden command for running MCP server. Spawns MCP Docker container and proxies stdio for MCP transport.
runCommand
  .command('mcp')
  .description('Run the SonarQube MCP server (stdio transport, for use in agent MCP configs)')
  .option('--debug', 'Enable debug logging in the MCP server container')
  .option('--read-only', 'Start the MCP server in read-only mode')
  .option(
    '--toolsets <toolsets>',
    'Comma-separated list of toolsets to enable (e.g. issues,quality-gates,duplications,dependency-risks,coverage,cag,portfolios)',
  )
  .option('-p, --project <project>', 'Project key (overrides auto-discovery)')
  .addHelpText(`after`, projectKeyExtraHelp)
  .authenticatedAction(
    (auth, options: { debug?: boolean; readOnly?: boolean; toolsets?: string; project?: string }) =>
      runMcp(auth, options),
  );

// Hidden callback command — internal handlers for agent and git hooks.
// Shell hook scripts call `sonar hook <event>` to delegate all business logic to TypeScript.
export const hookCommand = COMMAND_TREE.command('hook', { hidden: true })
  .description('Internal hook handlers for agent and git hooks')
  .enablePositionalOptions()
  .anonymousAction(function (this: Command) {
    this.outputHelp();
  });

hookCommand
  .command('claude-pre-tool-use')
  .description('PreToolUse handler: scan files for secrets before agent reads them')
  .anonymousAction(() => claudePreToolUse());

hookCommand
  .command('copilot-pre-tool-use')
  .description('PreToolUse handler for Copilot: scan files for secrets before agent reads them')
  .anonymousAction(() => copilotPreToolUse());

hookCommand
  .command('claude-prompt-submit')
  .description('UserPromptSubmit handler: scan prompts for secrets before sending')
  .anonymousAction(() => agentPromptSubmit());

hookCommand
  .command('codex-prompt-submit')
  .description('UserPromptSubmit handler for Codex: scan prompts for secrets before sending')
  .anonymousAction(() => codexPromptSubmit());

hookCommand
  .command('claude-post-tool-use')
  .description('PostToolUse handler: run Agentic Analysis after agent edits or writes a file')
  .requiredOption('--project <key>', 'SonarQube Cloud project key')
  .anonymousAction((options: AgentPostToolUseOptions) => agentPostToolUse(options));

hookCommand
  .command('git-pre-commit')
  .description('git pre-commit handler: scan staged files for secrets')
  .anonymousAction(() => gitPreCommit());

hookCommand
  .command('git-pre-push')
  .description('git pre-push handler: scan files in new commits for secrets')
  .anonymousAction(() => gitPrePush());

// Hidden flush command — only registered when running as a telemetry worker.
if (process.env[TELEMETRY_FLUSH_MODE_ENV]) {
  COMMAND_TREE.command('flush-telemetry', { hidden: true }).anonymousAction(flushTelemetry);
}

// Defer Sentry initialization until a command action is about to run, so that
// non-execution paths like --help, --version, and unknown commands don't pay
// for it. The guard avoids re-loading state and re-initializing on nested commands.
let sentryInitialized = false;
COMMAND_TREE.hook('preAction', () => {
  if (sentryInitialized) return;
  sentryInitialized = true;
  initSentry(loadState());
});

// Collect a telemetry event after every command action.
COMMAND_TREE.hook('postAction', async (_thisCommand, actionCommand) => {
  await storeEvent(actionCommand, (process.exitCode ?? 0) === 0);
});
