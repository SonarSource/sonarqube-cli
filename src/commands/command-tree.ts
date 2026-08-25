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

import { type Command, Help, InvalidArgumentError } from 'commander';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import { CURRENT_DISTRIBUTION } from '@/core/host/distribution.ts';
import { initSentry } from '@/core/observability/sentry.ts';
import { GENERIC_HTTP_METHODS } from '@/core/server/client.ts';
import { MAX_PAGE_SIZE } from '@/core/server/projects.ts';
import { tryLoadState } from '@/core/state/state-repository.ts';
import {
  flushTelemetry,
  setPassthroughSubcommand,
  storeEvent,
  TELEMETRY_FLUSH_MODE_ENV,
} from '@/core/telemetry';
import { createAgentSessionSlot, resolveAgentSessionId } from '@/core/telemetry/agent-session.ts';
import {
  SQAA_ANALYZE_AGENTIC_CALLER_COMMAND,
  SQAA_VERIFY_CALLER_COMMAND,
} from '@/core/telemetry/sqaa-analysis-telemetry.ts';
import { blank, error, warn } from '@/core/ui';
import { parseInteger } from '@/core/ui/parsing.ts';

import { version as VERSION } from '../../package.json';
import { analyzeAll, type AnalyzeAllOptions } from './analyze/analyze-all.ts';
import type { Severity } from './analyze/dependency-risk-helpers/sca-scanner.ts';
import { SEVERITIES } from './analyze/dependency-risk-helpers/view-model/build/severity.ts';
import {
  analyzeDependencyRisks,
  type AnalyzeDependencyRisksOptions,
  VALID_FORMATS as DEPENDENCY_RISKS_FORMATS,
} from './analyze/dependency-risks.ts';
import { analyzeSecrets, type AnalyzeSecretsOptions } from './analyze/secrets.ts';
import {
  analyzeSqaa,
  type AnalyzeSqaaOptions,
  type AnalyzeSqaaRunOptions,
  VALID_FORMATS as SQAA_FORMATS,
} from './analyze/sqaa.ts';
import { SQAA_DEPTH_CHOICES } from './analyze/sqaa-depth.ts';
import { collectSqaaFileOption } from './analyze/sqaa-file-arg.ts';
import { apiCommand, type ApiCommandOptions, apiExtraHelpText } from './api/api.ts';
import { authLogin, type AuthLoginOptions } from './auth/login.ts';
import { authLogout } from './auth/logout.ts';
import { authStatus } from './auth/status.ts';
import { type CommandInvocationContext } from './command-invocation-context.ts';
import { configureTelemetry, type ConfigureTelemetryOptions } from './config/telemetry.ts';
import { derivePassthroughSubcommand, runContextPassthrough } from './context';
import { agentPostToolUse } from './hook/agent-post-tool-use.ts';
import { agentPromptSubmit } from './hook/agent-prompt-submit.ts';
import { antigravityPreToolUse } from './hook/antigravity-pre-tool-use.ts';
import { claudePostToolUseFailure } from './hook/claude-post-tool-use-failure.ts';
import { claudePreToolUse } from './hook/claude-pre-tool-use.ts';
import { codexPostToolUse } from './hook/codex-post-tool-use.ts';
import { codexPromptSubmit } from './hook/codex-prompt-submit.ts';
import { copilotPreToolUse } from './hook/copilot-pre-tool-use.ts';
import { cursorPreFileRead } from './hook/cursor-pre-file-read.ts';
import { cursorPreToolUse } from './hook/cursor-pre-tool-use.ts';
import { cursorPromptSubmit } from './hook/cursor-prompt-submit.ts';
import { gitPreCommit, type GitPreCommitOptions } from './hook/git-pre-commit.ts';
import { gitPrePush } from './hook/git-pre-push.ts';
import type { HookCommandResult } from './hook/hook-command-result.ts';
import { importHandler, type ImportOptions } from './import';
import { collectRepoOption } from './import/_common/repo-option.ts';
import type { IntegrateAgentOptions } from './integrate/_common/types.ts';
import { integrateAntigravity } from './integrate/antigravity';
import { integrateClaude } from './integrate/claude';
import { integrateCodex } from './integrate/codex';
import { integrateCopilot } from './integrate/copilot';
import { integrateCursor } from './integrate/cursor';
import { integrateGit, type IntegrateGitOptions } from './integrate/git';
import { integrateBare, type IntegrateBareOptions } from './integrate/integrate-bare.ts';
import {
  listIssues,
  type ListIssuesOptions,
  VALID_FORMATS,
  VALID_MQR_SEVERITIES,
  VALID_STANDARD_SEVERITIES,
  VALID_STATUSES,
} from './list/issues.ts';
import { listProjects, type ListProjectsOptions } from './list/projects.ts';
import { remediate, type RemediateOptions } from './remediate';
import { getBanner, getCustomRootHelp } from './root-help.ts';
import { runMcp } from './run/mcp.ts';
import {
  type CliRuntime,
  collectPrivateBetaFlagKeys,
  createDefaultCliRuntime,
  isAlphaEnabledFromEnv,
  SonarCommand,
  SonarOption,
} from './sonar-command.ts';
import { systemReset, type SystemResetOptions } from './system/reset.ts';
import { systemStatus, type SystemStatusOptions } from './system/status.ts';
import { updateVersion, type UpdateVersionOptions } from './update';

const DEFAULT_PAGE_SIZE = MAX_PAGE_SIZE;

const projectKeyExtraHelp = `
Instead of providing an explicit --project, you can add sonar.projectKey to sonar-project.properties at the repository root.
Alternatively, add SonarQube for IDE shared binding JSON under .sonarlint/ (for example .sonarlint/connectedMode.json) that includes projectKey.
`;

const dependencyRisksExtraHelp = `
Dependency manifest files (e.g. package-lock.json, pom.xml) will be uploaded to SonarQube for analysis.
Learn more: https://docs.sonarsource.com/sonarqube-server/advanced-security/analyzing-projects-for-dependencies#supported-languages-and-package-managers
${projectKeyExtraHelp}`;

/**
 * Loads auth + Private Beta flag decisions. Invoked at most once, only when the
 * tree declares at least one Private Beta command.
 */
export type LoadPrivateBetaContext = (flagKeys: readonly string[]) => Promise<{
  auth: ResolvedAuth | null;
  flags: Record<string, boolean>;
}>;

export interface CreateCommandTreeOptions {
  isAlphaEnabled?: boolean;
  loadPrivateBetaContext?: LoadPrivateBetaContext;
}

/** Registers the full command tree for the given runtime (sync). */
function buildCommandTree(runtime: CliRuntime): SonarCommand {
  // Per-tree slot for agent session correlation. Hook handlers write ids when
  // present; postAction resolves (env fallback) before telemetry flush.
  const agentSession = createAgentSessionSlot();
  const COMMAND_TREE = new SonarCommand({ runtime });

  const handleHookInvocation =
    <TArgs extends unknown[]>(
      run: (...args: TArgs) => Promise<HookCommandResult>,
    ): ((_ctx: CommandInvocationContext, ...args: TArgs) => Promise<void>) =>
    async (_ctx, ...args) => {
      const { agentSessionId } = await run(...args);
      if (agentSessionId != null) {
        agentSession.id = agentSessionId;
      }
    };

  COMMAND_TREE.name('sonar')
    .description('SonarQube CLI')
    .argument('[command]')
    .version(VERSION, '-v, --version', 'display version for command')
    .enablePositionalOptions()
    .configureOutput({
      outputError: (str) => {
        blank();
        error(str.trim());
      },
    })
    .configureHelp({
      formatHelp: (cmd, helper) => {
        if (!cmd.parent) {
          return getCustomRootHelp(cmd as SonarCommand, helper);
        }
        return getBanner(VERSION) + '\n' + Help.prototype.formatHelp.call(helper, cmd, helper);
      },
    })
    .anonymousAction(function (this: Command, _ctx, command?: string) {
      if (command) {
        throw new CommandFailedError(`unknown command '${command}'`, {
          remediationHint: "Run 'sonar --help' to see the list of available commands.",
        });
      }
      this.outputHelp();
    });

  // Manage authentication tokens and credentials
  const auth = COMMAND_TREE.command('auth')
    .description('Manage authentication tokens and credentials')
    .rootHelp({
      category: 'cli-management',
    })
    .showUpdateNotification();

  auth
    .command('login')
    .description(
      'Authenticate via browser and save credentials in the system keychain. ' +
        'Must be run manually — agents cannot authenticate themselves. ' +
        'For CI and automation, use environment variables instead: https://docs.sonarsource.com/sonarqube-cli/using-sonarqube-cli/environment-variables',
    )
    .option(
      '-s, --server <server>',
      'SonarQube Server URL, SonarQube Cloud EU (https://sonarcloud.io), or SonarQube Cloud US (https://sonarqube.us). Defaults to SonarQube Cloud EU.',
    )
    .option('-o, --org <org>', 'SonarQube Cloud organization key (required for SonarQube Cloud)')
    .anonymousAction((_ctx, options: AuthLoginOptions) => authLogin(options));

  auth
    .command('logout')
    .description('Remove active connection token from keychain')
    .anonymousAction((_ctx) => authLogout());

  auth
    .command('status')
    .description('Show active authentication connection with token verification')
    .anonymousAction((_ctx) => authStatus());

  // List Sonar resources
  const list = COMMAND_TREE.command('list')
    .description('List issues and projects from SonarQube Cloud or Server')
    .rootHelp({
      category: 'data',
    });

  const pageOption = new SonarOption('--page <page>', 'Page number')
    .default(1)
    .argParser(parseInteger);
  const pageSizeOption = new SonarOption('--page-size <page-size>', 'Page size (1-500)')
    .default(DEFAULT_PAGE_SIZE)
    .argParser(parseInteger);
  const listIssuesFormatOption = new SonarOption('--format <format>', 'Output format')
    .choices(VALID_FORMATS)
    .default('json');
  list
    .command('issues')
    .description('Search for issues in SonarQube')
    .showUpdateNotification((opts) => {
      const format = typeof opts.format === 'string' ? opts.format : 'json';
      return format.toLowerCase() === 'table';
    })
    .requiredOption('-p, --project <project>', 'Project key')
    .option(
      '--statuses <statuses>',
      `Filter by status (comma-separated list of: ${VALID_STATUSES.join(', ')})`,
    )
    .option(
      '--severities <severities>',
      `Filter by severity. Valid values depend on server mode — Multi-Quality Rule (MQR) mode: ${VALID_MQR_SEVERITIES.join(', ')}; Standard Experience mode: ${VALID_STANDARD_SEVERITIES.join(', ')}.`,
    )
    .addOption(listIssuesFormatOption)
    .option('--branch <branch>', 'Branch name')
    .option('--pull-request <pull-request>', 'Pull request ID')
    .addOption(pageSizeOption)
    .addOption(pageOption)
    .authenticatedAction((ctx, options: ListIssuesOptions) => listIssues(options, ctx));

  list
    .command('projects')
    .description('Search for projects in SonarQube')
    .showUpdateNotification()
    .option('-q, --query <query>', 'Search query to filter projects by name or key')
    .addOption(pageOption)
    .addOption(pageSizeOption)
    .authenticatedAction((ctx, options: ListProjectsOptions) => listProjects(options, ctx));

  // Import repositories from DevOps platforms into SonarQube (hidden while in development)
  COMMAND_TREE.command('import', { hidden: true })
    .description('Import repositories from a connected DevOps platform into SonarQube')
    .option(
      '--repo <slug>',
      'DevOps platform repository slug (e.g. my-org/my-repo). Repeatable and/or comma-separated to import multiple repositories. Cannot be combined with --all or --regex.',
      collectRepoOption,
      [],
    )
    .option(
      '--all',
      'Import every eligible repository in the organization (not already imported, and allowed by its project visibility settings). Cannot be combined with --repo or --regex.',
    )
    .option(
      '--regex <regex>',
      'Import only eligible repositories whose DevOps platform name (not slug) matches this regular expression.\n' +
        '\n' +
        '                   Case-sensitive by default; wrap as /pattern/flags to add flags like case-insensitive matching. Cannot be combined with --repo or --all.\n' +
        '                   Examples:\n' +
        '                       --regex "^test-"\n' +
        '                       --regex "/^archived-/i"\n',
    )
    .option('--non-interactive', 'Skip all prompts; require explicit flags')
    .authenticatedAction((ctx, options: ImportOptions) => importHandler(options, ctx));

  COMMAND_TREE.command('api')
    .rootHelp({
      category: 'data',
      label: 'api <method> <endpoint>',
    })
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
    .authenticatedAction((ctx, method: string, endpoint: string, options: ApiCommandOptions) =>
      apiCommand(ctx, method, endpoint, options),
    );

  // Setup SonarQube integration for AI coding agent
  const integrateCommand = COMMAND_TREE.command('integrate')
    .description('Setup SonarQube integration for AI coding agents, git and others.')
    .rootHelp({
      category: 'integrate',
    })
    .showUpdateNotification((opts) => !opts.nonInteractive)
    .option('-p, --project <project>', 'Project key. Mutually exclusive with --global.')
    .option('-g, --global', 'Install integrations globally.')
    .rejectUnknownSubcommands()
    .authenticatedAction((ctx, options: IntegrateBareOptions) => integrateBare(ctx, options));

  integrateCommand
    .command('git')
    .description(
      'Install a Git pre-commit hook that scans staged files for secrets and dependency risks before each commit, or a Git pre-push hook that scans committed files for secrets before each push.',
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
    .option(
      '--dependency-risks',
      'Also install a pre-commit dependency-risks scan (requires -p, not supported with --global)',
    )
    .option(
      '-p, --project <project>',
      'Project key baked into the dependency-risks hook (required with --dependency-risks)',
    )
    .authenticatedAction((ctx, options: IntegrateGitOptions) => integrateGit(options, ctx));

  integrateCommand
    .command('claude')
    .description(
      'Setup SonarQube integration for Claude Code. This will install secrets scanning hooks, configure Vortex analysis and MCP Server.',
    )
    .option('-p, --project <project>', 'Project key. Ignored when --global is used.')
    .option('--non-interactive', 'Non-interactive mode (no prompts)')
    .option(
      '-g, --global',
      'Install hooks and config globally to ~/.claude instead of project directory',
    )
    .addHelpText('after', projectKeyExtraHelp)
    .authenticatedAction((ctx, options: IntegrateAgentOptions) => integrateClaude(options, ctx));

  integrateCommand
    .command('copilot')
    .description(
      'Setup SonarQube integration for GitHub Copilot CLI. This will install secrets scanning hooks, configure Vortex analysis and MCP Server.',
    )
    .option(
      '-g, --global',
      'Install hooks and config globally to ~/.copilot instead of project directory',
    )
    .option('-p, --project <project>', 'Project key. Mutually exclusive with --global.')
    .option('--non-interactive', 'Non-interactive mode (no prompts)')
    .addHelpText('after', projectKeyExtraHelp)
    .authenticatedAction((ctx, options: IntegrateAgentOptions) => integrateCopilot(options, ctx));

  // `sonar context` — passthrough wrapper for sonar-context-augmentation.
  // Forwards arguments verbatim to the locally-installed CAG binary; install via
  // `sonar integrate claude` or `sonar integrate copilot`.
  COMMAND_TREE.command('context')
    .description('Augment AI agents with context from your codebase')
    .rootHelp({
      category: 'data',
      label: 'context [action] [args...]',
    })
    .argument('[action]', 'Action forwarded to sonar-context-augmentation')
    .argument('[args...]', 'Additional arguments forwarded to sonar-context-augmentation')
    .helpOption(false)
    .passThroughOptions()
    .allowUnknownOption()
    .anonymousAction(function (
      this: SonarCommand,
      _ctx,
      action: string | undefined,
      args: string[],
    ) {
      setPassthroughSubcommand(this, derivePassthroughSubcommand(action, args));
      return runContextPassthrough(action, args);
    });

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
    .option('--non-interactive', 'Non-interactive mode (no prompts)')
    .addHelpText('after', projectKeyExtraHelp)
    .authenticatedAction((ctx, options: IntegrateAgentOptions) => integrateCodex(options, ctx));

  integrateCommand
    .command('antigravity')
    .description(
      'Setup SonarQube integration for Antigravity. Installs secrets scanning hooks, prompt-secrets instructions, and Vortex Context.',
    )
    .option('-p, --project <project>', 'Project key. Mutually exclusive with --global.')
    .option('--non-interactive', 'Non-interactive mode (no prompts)')
    .option(
      '-g, --global',
      'Install hooks and config globally under ~/.gemini/config instead of the project .agents/ directory',
    )
    .addHelpText('after', projectKeyExtraHelp)
    .authenticatedAction((ctx, options: IntegrateAgentOptions) =>
      integrateAntigravity(options, ctx),
    );

  integrateCommand
    .command('cursor')
    .description(
      'Setup SonarQube integration for Cursor. This will configure the SonarQube MCP Server, install secrets scanning hooks, and configure Vortex analysis.',
    )
    .option('-p, --project <project>', 'Project key. Mutually exclusive with --global.')
    .option('--non-interactive', 'Non-interactive mode (no prompts)')
    .option(
      '-g, --global',
      "Install config globally to ~/.cursor instead of project directory. Note: Cursor's cloud/background agents only pick up project-level hooks, not global ones.",
    )
    .addHelpText('after', projectKeyExtraHelp)
    .authenticatedAction((ctx, options: IntegrateAgentOptions) => integrateCursor(options, ctx));

  // Analyze code for quality and security issues
  const analyze = COMMAND_TREE.command('analyze')
    .description('Analyze code for quality and security issues')
    .rootHelp({
      category: 'core',
      expandSubcommands: true,
    })
    .showUpdateNotification()
    .enablePositionalOptions()
    .rejectUnknownSubcommands();

  analyze
    .command('secrets')
    .description('Scan files or stdin for hardcoded secrets')
    .argument('[paths...]', 'File or directory paths to scan for secrets')
    .option('--stdin', 'Read from standard input instead of paths')
    .authenticatedAction((ctx, paths: string[], options: AnalyzeSecretsOptions) =>
      analyzeSecrets({ paths: Array.isArray(paths) ? paths : [], stdin: options.stdin }, ctx),
    );

  // Shared option set for `analyze agentic` and `verify`.
  const sqaaFormatOption = new SonarOption('--format <format>', 'Output format')
    .choices(SQAA_FORMATS)
    .default('text');

  const sqaaDepthOption = new SonarOption(
    '--depth <depth>',
    'Analysis depth: STANDARD (fast) or DEEP (cross-file). Default: STANDARD for one --file; DEEP otherwise.',
  ).choices(SQAA_DEPTH_CHOICES);

  // Options shared between the bare `analyze` command and its `agentic` subcommand.
  // `--branch` is intentionally excluded from the bare command.
  function applyBaseAgenticOptions(cmd: SonarCommand): SonarCommand {
    return cmd
      .option(
        '--file <path>',
        'Analyze specific file(s) instead of the git change set (repeatable)',
        collectSqaaFileOption,
      )
      .option('--staged', 'Analyze staged files only (git diff --cached)')
      .option('--base <ref>', 'Analyze files changed vs a branch or ref (e.g. main)')
      .option(
        '-p, --project <project>',
        'SonarQube Cloud project key (overrides auto-detected project)',
      )
      .option('--force', 'Skip the large change set confirmation prompt')
      .addOption(sqaaDepthOption)
      .addOption(sqaaFormatOption);
  }

  function applySqaaOptions(
    cmd: SonarCommand,
    runOptions: AnalyzeSqaaRunOptions = {},
  ): SonarCommand {
    return applyBaseAgenticOptions(cmd)
      .option('--branch <branch>', 'Branch name for analysis context')
      .authenticatedAction((ctx, options: AnalyzeSqaaOptions) =>
        analyzeSqaa(options, ctx, runOptions),
      );
  }

  // Default action for `sonar analyze` (no subcommand): run all analyses (secrets + agentic).
  applyBaseAgenticOptions(analyze).authenticatedAction((ctx, options: AnalyzeAllOptions) =>
    analyzeAll(options, ctx),
  );

  const dependencyRisksFormatOption = new SonarOption('--format <format>', 'Output format')
    .choices(DEPENDENCY_RISKS_FORMATS)
    .default('table');

  const dependencyRisksStatusFilterOption = new SonarOption(
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

  const dependencyRisksMinSeverityOption = new SonarOption(
    '--min-severity <severity>',
    `Minimum severity level to include. Allowed values: ${SEVERITIES.join(', ')} (default: all severities)`,
  ).argParser((v) => {
    const upper = v.toUpperCase();
    if (!SEVERITIES.includes(upper as Severity)) {
      throw new InvalidArgumentError(`Allowed choices are ${SEVERITIES.join(', ')}.`);
    }
    return upper;
  });

  analyze
    .command('dependency-risks')
    .description('Analyze project dependencies for security and license risks')
    .option('-p, --project <project>', 'Project key (auto-detected when omitted)')
    .addOption(dependencyRisksFormatOption)
    .addOption(dependencyRisksStatusFilterOption)
    .addOption(dependencyRisksMinSeverityOption)
    .addHelpText('after', dependencyRisksExtraHelp)
    .authenticatedAction((ctx, options: AnalyzeDependencyRisksOptions) =>
      analyzeDependencyRisks(options, ctx),
    );

  applySqaaOptions(
    analyze
      .command('agentic')
      .description('Run server-side Vortex analysis (SonarQube Cloud only). Limitations apply.'),
    { telemetryCallerCommand: SQAA_ANALYZE_AGENTIC_CALLER_COMMAND },
  );

  // `verify` is deprecated in favour of `sonar analyze`.
  const verifyCmd = applySqaaOptions(
    COMMAND_TREE.command('verify', { hidden: true }).description(
      "Run server-side Vortex analysis (deprecated — use 'sonar analyze' instead)",
    ),
    { telemetryCallerCommand: SQAA_VERIFY_CALLER_COMMAND },
  );
  verifyCmd.hook('preAction', () => {
    warn(
      "sonar verify is deprecated and will be removed in a future major version. Use 'sonar analyze' instead.",
    );
  });

  // Trigger AI remediation for eligible issues (SonarQube Cloud only)
  COMMAND_TREE.command('remediate')
    .description('Trigger AI agent remediation for eligible issues (SonarQube Cloud only)')
    .rootHelp({
      category: 'core',
    })
    .option(
      '-p, --project <project>',
      'SonarQube Cloud project key (overrides auto-detected project)',
    )
    .option(
      '--issues <issueIds>',
      'Comma-separated issue keys to remediate non-interactively (max 20). Required when stdin is not a TTY.',
    )
    .authenticatedAction((ctx, options: RemediateOptions) => remediate(options, ctx));

  // Configure things related to the CLI
  const configure = COMMAND_TREE.command('config').description('Configure CLI settings');
  configure.rootHelp({
    category: 'cli-management',
  });

  configure
    .command('telemetry')
    .description('Configure telemetry settings')
    .option('--enabled', 'Enable collection of anonymous usage statistics')
    .option('--disabled', 'Disable collection of anonymous usage statistics')
    .anonymousAction((_ctx, options: ConfigureTelemetryOptions) => configureTelemetry(options));

  // System diagnostics and maintenance
  const system = COMMAND_TREE.command('system')
    .description('System diagnostics and maintenance commands for the SonarQube CLI installation.')
    .rootHelp({
      category: 'cli-management',
    });

  system
    .command('status')
    .description('Show overall system status: authentication, installed binaries, and integrations')
    .showUpdateNotification((opts) => !opts.json)
    .option('--json', 'Output as JSON for machine consumption')
    .anonymousAction((_ctx, options: SystemStatusOptions) => systemStatus(options));

  system
    .command('reset')
    .description(
      'Reset the CLI to factory defaults: remove tokens, binaries, integrations, and cached files. ' +
        'Telemetry settings are preserved.',
    )
    .option(
      '--force',
      'Skip the interactive confirmation prompt (required for non-interactive use)',
    )
    .anonymousAction((_ctx, options: SystemResetOptions) => systemReset(options));

  // Update the CLI to the latest version
  if (CURRENT_DISTRIBUTION.enableSelfUpdate) {
    COMMAND_TREE.command('update')
      .description('Update SonarQube CLI to the latest version')
      .rootHelp({
        category: 'cli-management',
      })
      .option('--status', 'Check for a newer version without installing')
      .option('--force', 'Install the latest version even if already up to date')
      .anonymousAction((_ctx, options: UpdateVersionOptions) => updateVersion(options));

    // `self-update` is deprecated in favour of `sonar update`.
    const selfUpdateCmd = COMMAND_TREE.command('self-update', { hidden: true })
      .description(
        "Update SonarQube CLI to the latest version (deprecated — use 'sonar update' instead)",
      )
      .option('--status', 'Check for a newer version without installing')
      .option('--force', 'Install the latest version even if already up to date')
      .anonymousAction((_ctx, options: UpdateVersionOptions) => updateVersion(options));
    selfUpdateCmd.hook('preAction', () => {
      warn(
        "sonar self-update is deprecated and will be removed in one of the upcoming versions. Use 'sonar update' instead.",
      );
    });
  }

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
      'Comma-separated list of toolsets to enable (e.g. issues,quality-gates,duplications,dependency-risks,coverage,vortex,portfolios)',
    )
    .option('-p, --project <project>', 'Project key (overrides auto-discovery)')
    .addHelpText(`after`, projectKeyExtraHelp)
    .authenticatedAction(
      (
        ctx,
        options: { debug?: boolean; readOnly?: boolean; toolsets?: string; project?: string },
      ) => runMcp(ctx, options),
    );

  // Hidden callback command — internal handlers for agent and git hooks.
  // Shell hook scripts call `sonar hook <event>` to delegate all business logic to TypeScript.
  const hookCommand = COMMAND_TREE.command('hook', { hidden: true })
    .description('Internal hook handlers for agent and git hooks')
    .enablePositionalOptions()
    .anonymousAction(function (this: Command, _ctx) {
      this.outputHelp();
    });

  hookCommand
    .command('claude-pre-tool-use')
    .description('PreToolUse handler: scan files for secrets before agent reads them')
    .anonymousAction(handleHookInvocation(() => claudePreToolUse()));

  hookCommand
    .command('copilot-pre-tool-use')
    .description(
      'PreToolUse handler for GitHub Copilot CLI: scan files for secrets before agent reads them',
    )
    .anonymousAction((_ctx) => copilotPreToolUse());

  hookCommand
    .command('antigravity-pre-tool-use')
    .description(
      'PreToolUse handler for Antigravity: scan files for secrets before agent reads them',
    )
    .anonymousAction((_ctx) => antigravityPreToolUse());

  hookCommand
    .command('claude-prompt-submit')
    .description('UserPromptSubmit handler: scan prompts for secrets before sending')
    .anonymousAction(handleHookInvocation(() => agentPromptSubmit()));

  hookCommand
    .command('codex-prompt-submit')
    .description('UserPromptSubmit handler for Codex: scan prompts for secrets before sending')
    .anonymousAction(handleHookInvocation(() => codexPromptSubmit()));

  hookCommand
    .command('cursor-prompt-submit')
    .description('beforeSubmitPrompt handler for Cursor: scan prompts for secrets before sending')
    .anonymousAction(handleHookInvocation(() => cursorPromptSubmit()));

  hookCommand
    .command('cursor-pre-file-read')
    .description(
      'beforeReadFile handler for Cursor: scan files for secrets before agent reads them',
    )
    .anonymousAction(handleHookInvocation(() => cursorPreFileRead()));

  hookCommand
    .command('cursor-pre-tool-use')
    .description(
      'preToolUse handler for Cursor: scan Read tool targets for secrets before execution',
    )
    .anonymousAction(handleHookInvocation(() => cursorPreToolUse()));

  hookCommand
    .command('claude-post-tool-use')
    .description('PostToolUse handler: run Vortex analysis after agent edits or writes a file')
    .requiredOption('--project <key>', 'SonarQube Cloud project key')
    .anonymousAction(handleHookInvocation(agentPostToolUse));

  hookCommand
    .command('claude-post-tool-use-failure')
    .description(
      'PostToolUseFailure handler: forward the failed tool call to Vortex context augmentation',
    )
    .anonymousAction((_ctx) => claudePostToolUseFailure());

  hookCommand
    .command('codex-post-tool-use')
    .description(
      'PostToolUse handler for Codex: run Vortex analysis on the git change set after apply_patch',
    )
    .requiredOption('--project <key>', 'SonarQube Cloud project key')
    .anonymousAction(handleHookInvocation(codexPostToolUse));

  hookCommand
    .command('git-pre-commit')
    .description(
      'git pre-commit handler: scan staged files for secrets, optionally scan dependency manifests for risks',
    )
    .option('-p, --project <project>', 'Project key (required when --dependency-risks is set)')
    .option(
      '--dependency-risks',
      'Also run a dependency-risks scan after the secrets scan (requires -p)',
    )
    .argument('[files...]', 'Changed files passed by pre-commit (pass_filenames: true)')
    .anonymousAction((_ctx, files: string[], options: GitPreCommitOptions) =>
      gitPreCommit(options, files),
    );

  hookCommand
    .command('git-pre-push')
    .description('git pre-push handler: scan files in new commits for secrets')
    .argument('[files...]', 'Changed files passed by pre-commit (pass_filenames: true)')
    .anonymousAction((_ctx, files: string[]) => gitPrePush(files));

  // Hidden flush command — only registered when running as a telemetry worker.
  if (process.env[TELEMETRY_FLUSH_MODE_ENV]) {
    COMMAND_TREE.command('flush-telemetry', { hidden: true }).anonymousAction((_ctx) =>
      flushTelemetry(),
    );
  }

  // Defer Sentry initialization until a command action is about to run, so that
  // non-execution paths like --help, --version, and unknown commands don't pay
  // for it. The guard avoids re-loading state and re-initializing on nested commands.
  let sentryInitialized = false;
  COMMAND_TREE.hook('preAction', () => {
    if (sentryInitialized) return;
    sentryInitialized = true;
    const state = tryLoadState();
    if (state) initSentry(state);
  });

  // Collect a telemetry event after every command action.
  COMMAND_TREE.hook('postAction', async (_thisCommand, actionCommand) => {
    // Resolve/cache the agent session id for this invocation (env fallback when
    // no hook id). Emitting it on telemetry is CLI-959.
    resolveAgentSessionId(agentSession);
    await storeEvent(actionCommand, (process.exitCode ?? 0) === 0);
    await COMMAND_TREE.updateNotifier.maybeNotify(actionCommand);
  });

  return COMMAND_TREE;
}

/**
 * Build the CLI command tree for this invocation.
 *
 * Probes for Private Beta flag keys first. Only when at least one exists does it
 * call `loadPrivateBetaContext` (auth + LaunchDarkly). Otherwise the probe tree
 * is returned and LaunchDarkly is never contacted.
 */
export async function createCommandTree(
  options: CreateCommandTreeOptions = {},
): Promise<SonarCommand> {
  const isAlphaEnabled = options.isAlphaEnabled ?? isAlphaEnabledFromEnv();

  const probe = buildCommandTree({
    auth: null,
    isAlphaEnabled,
    // Allow all Private Beta commands so Stage.Beta('…') keys are discoverable.
    isPrivateBetaEnabled: () => true,
  });

  const flagKeys = collectPrivateBetaFlagKeys(probe);
  if (flagKeys.length === 0) {
    return probe;
  }

  if (options.loadPrivateBetaContext) {
    const { auth, flags } = await options.loadPrivateBetaContext(flagKeys);
    return buildCommandTree({
      auth,
      isAlphaEnabled,
      isPrivateBetaEnabled: (flagKey) => flags[flagKey] ?? false,
    });
  }

  // Keys exist but no loader (e.g. docs generation): omit Private Beta commands.
  return buildCommandTree({
    ...createDefaultCliRuntime(),
    isAlphaEnabled,
    isPrivateBetaEnabled: () => false,
  });
}
