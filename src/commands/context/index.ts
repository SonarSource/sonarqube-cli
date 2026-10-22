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

import { spawn } from 'node:child_process';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { recordedConnectionCredentialSource } from '@/core/auth/recorded-connection.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { SONAR_CONTEXT_INVOCATION } from '@/core/config-constants.ts';
import { buildContextAugmentationEnv } from '@/core/host/context-augmentation-env.ts';
import { resolveContextAugmentationBinaryPath } from '@/core/host/install/context-augmentation.ts';
import { getToken, MissingKeychainError } from '@/core/host/keychain.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import type { DiscoveredProjects } from '@/core/project-discovery/project-discovery-result.ts';
import { discoverProjects } from '@/core/project-discovery/project-info.ts';
import type { Console } from '@/core/ui/console.ts';

// Commander may assign --help/-h to the optional [action] positional on some platforms.
function buildForwardedArgs(
  action: string | undefined,
  args: string[],
): { forwarded: string[]; isHelp: boolean } {
  let forwarded: string[];
  if (action) {
    forwarded = [action, ...args];
  } else if (args.length > 0) {
    forwarded = args;
  } else {
    forwarded = ['--help'];
  }
  const isHelp = forwarded[0] === '--help' || forwarded[0] === '-h';
  return { forwarded, isHelp };
}

/**
 * Derive the telemetry subcommand for a `sonar context` passthrough invocation.
 * Records `help` for --help/-h, leading positional tokens up to the first flag
 * for normal actions (e.g. `tool stop` for `tool stop --all`), and null for bare
 * `sonar context`. Whitespace inside or between tokens is collapsed to a single
 * space so quoting quirks don't create separate telemetry buckets. Option values
 * are intentionally never captured.
 */
export function derivePassthroughSubcommand(
  action: string | undefined,
  args: string[],
): string | null {
  const all = action ? [action, ...args] : args;
  if (all.length === 0) return null;
  if (all[0] === '--help' || all[0] === '-h') return 'help';
  const positionals: string[] = [];
  for (const token of all) {
    if (token.startsWith('-')) break;
    for (const word of token.split(/\s+/)) {
      if (word.length > 0) positionals.push(word);
    }
  }
  return positionals.length > 0 ? positionals.join(' ') : null;
}

interface RecordedContextAugmentationConfig {
  organization?: string;
  projectKey?: string;
  serverUrl?: string;
  /** The discovered project's own directory; set only when a project actually resolved. */
  workspaceDir?: string;
}

/**
 * Resolve org/project/server via the shared project-discovery pipeline (`discoverProjects`, the
 * same one SQAA's lookup uses), scoped to `cwd`. `workspaceDir` is the project's `projectRoot`
 * directly — discovery always anchors it to the current worktree (never a different one a matched
 * mapping happens to point at), so no extra resolution is needed here. When `requiresSingleProject`
 * is set, several projects covering `cwd`, or linked projects none of which covers it, throw.
 */
async function resolveRecordedContextAugmentationConfig(
  cwd: string,
  auth: ResolvedAuth,
  console: Console,
  requiresSingleProject: boolean,
): Promise<RecordedContextAugmentationConfig> {
  const discovered = await discoverProjects(cwd, {
    auth,
    silent: true,
    console,
  });
  const scoped = discovered.scope(cwd);
  if (scoped.length === 1) {
    const [project] = scoped;
    return {
      organization: project.organization,
      projectKey: project.projectKey,
      serverUrl: project.serverUrl,
      workspaceDir: project.projectRoot,
    };
  }
  // Only `.sonar-config.json` yields several projects; without it, CAG's own "integration context missing" error already says what to do.
  if (requiresSingleProject && discovered.fromSharedConfig) {
    throw new CommandFailedError(
      `Could not determine a single SonarQube project for ${canonicalizePath(cwd)}.`,
      {
        remediationHint: unresolvedProjectHint(discovered, cwd),
      },
    );
  }
  return {};
}

function unresolvedProjectHint(discovered: DiscoveredProjects, path: string): string {
  const dir = canonicalizePath(path);
  const scoped = discovered.scope(dir);
  if (scoped.length === 0) {
    return (
      `${dir} is not inside any project linked in .sonar-config.json. ` +
      `Run 'sonar link list' from the repository root (${discovered.repoRoot ?? dir}) to see where they are.`
    );
  }
  const enclosingCount = scoped.filter((project) => project.contains).length;
  if (enclosingCount > 1) {
    return (
      `${dir} is inside ${enclosingCount} nested projects, which are not supported yet. ` +
      "Run 'sonar link list' to list them, then work from a directory that belongs to only one."
    );
  }
  return (
    `${scoped.length} projects are linked at or under ${dir}. ` +
    "Run 'sonar link list --path <path>' with the file or directory to work on; a single result is its project. " +
    "Then re-run from that project's directory."
  );
}

/** Management (`tool`), hook (`__hook`) and help requests run without a project, so they never fail on an ambiguous one. */
function requiresSingleProject(forwarded: string[]): boolean {
  const [action] = forwarded;
  if (forwarded.includes('--help') || forwarded.includes('-h')) {
    return false;
  }
  return action !== 'tool' && !action.startsWith('__');
}

async function resolveContextToken(
  auth: ResolvedAuth,
  serverUrl: string,
  organization: string | undefined,
): Promise<string> {
  const connection = organization ? `${serverUrl} (${organization})` : serverUrl;
  const organizationHint = organization ? ` plus SONARQUBE_CLI_ORG=${organization}` : '';
  const credentialSource = recordedConnectionCredentialSource(auth, serverUrl, organization);
  if (credentialSource === 'active') {
    return auth.token;
  }

  if (credentialSource === 'different-server') {
    const remediationHint = auth.comesFromEnv()
      ? `Environment credentials point at ${auth.serverUrl}. Set SONARQUBE_CLI_SERVER=${serverUrl}` +
        organizationHint +
        ' with a matching SONARQUBE_CLI_TOKEN, or unset SONARQUBE_CLI_TOKEN, SONARQUBE_CLI_SERVER, and SONARQUBE_CLI_ORG, then ' +
        `run sonar auth login --server ${serverUrl}.`
      : `Run sonar auth login --server ${serverUrl} first.`;
    throw new CommandFailedError(
      `Not authenticated for the recorded Vortex Context connection: ${connection}.`,
      { remediationHint },
    );
  }

  let token: string | null = null;
  let keychainUnavailable = false;
  try {
    token = await getToken(serverUrl, organization);
  } catch (err) {
    if (!(err instanceof MissingKeychainError)) {
      throw err;
    }
    // Treat a missing keychain as no stored token so the recorded-connection error below
    // surfaces with guidance that does not require keychain access.
    keychainUnavailable = true;
    logger.debug(`Keychain lookup failed for ${serverUrl}: ${err.message}`);
  }
  if (token) {
    return token;
  }

  throw new CommandFailedError(
    `Not authenticated for the recorded Vortex Context connection: ${connection}.`,
    {
      // With a working keychain, logging in is the fix. If libsecret cannot be loaded,
      // `sonar auth login` cannot store its token in that keychain.
      //
      // Environment credentials for another organization on this server are ignored here.
      remediationHint: keychainUnavailable
        ? 'The system keychain is unavailable because libsecret could not be loaded. Install or repair libsecret, or ' +
          `authenticate with environment variables matching the recorded connection: set SONARQUBE_CLI_TOKEN and SONARQUBE_CLI_SERVER=${serverUrl}` +
          organizationHint +
          '. ' +
          'Credentials for another organization on this server are ignored. ' +
          'If the connection above is itself wrong, re-run sonar integrate claude or ' +
          'sonar integrate copilot from this project to record the right one.'
        : 'Run: sonar auth login, then re-run sonar integrate claude or sonar integrate copilot from this project.',
    },
  );
}

export interface RunContextPassthroughOptions {
  stdinPayload?: string;
  ctx: CommandInvocationContext;
}

export async function runContextPassthrough(
  action: string | undefined,
  args: string[],
  options: RunContextPassthroughOptions,
): Promise<void> {
  const binaryPath = resolveContextAugmentationBinaryPath() ?? 'sonar-context-augmentation';
  const { forwarded, isHelp } = buildForwardedArgs(action, args);

  let env: NodeJS.ProcessEnv;
  if (isHelp) {
    env = await buildContextAugmentationEnv();
  } else {
    const authResult = await options.ctx.resolveAuth();
    if (authResult.isErr()) {
      throw authResult.error;
    }
    const auth = authResult.value;
    if (!auth) {
      throw new CommandFailedError('Not authenticated.', {
        remediationHint: 'Run: sonar auth login',
      });
    }
    const recordedConfig = await resolveRecordedContextAugmentationConfig(
      process.cwd(),
      auth,
      options.ctx.console,
      requiresSingleProject(forwarded),
    );
    const serverUrl = recordedConfig.serverUrl ?? auth.serverUrl;
    const organization = recordedConfig.organization ?? auth.orgKey;
    env = await buildContextAugmentationEnv({
      organization,
      projectKey: recordedConfig.projectKey,
      serverUrl,
      token: await resolveContextToken(auth, serverUrl, organization),
      workspaceDir: recordedConfig.workspaceDir,
    });
  }

  const { stdinPayload } = options;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, forwarded, {
      stdio: stdinPayload === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
      env,
      argv0: SONAR_CONTEXT_INVOCATION,
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new CommandFailedError('Vortex Context is not installed.', {
            remediationHint:
              'Run "sonar integrate claude" or "sonar integrate copilot" to install it.',
          }),
        );
      } else {
        reject(err);
      }
    });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });

    if (stdinPayload !== undefined) {
      // Rejecting here would let the child's later exit overwrite the failure, so its exit code reports the outcome.
      child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EPIPE') {
          logger.warn(`Could not deliver input to Vortex Context: ${err.message}`);
        }
      });
      child.stdin?.end(stdinPayload);
    }
  });
}
