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

import { resolveAuth, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import { SONAR_CONTEXT_INVOCATION } from '@/core/config-constants.ts';
import { buildContextAugmentationEnv } from '@/core/host/context-augmentation-env.ts';
import { resolveContextAugmentationBinaryPath } from '@/core/host/install/context-augmentation.ts';
import { getToken } from '@/core/host/keychain.ts';
import { discoverProject } from '@/core/project-info.ts';
import { TerminalConsole } from '@/core/ui/terminal-console.ts';
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
 * Resolve org/project/server via the shared project-discovery pipeline (`discoverProject`),
 * the same one SQAA's project-key lookup uses (see resolveSqaaProjectKey). `workspaceDir` is
 * `discovered.projectRoot` directly — `discoverProject()` itself always anchors it to the
 * current worktree (never a different one a matched mapping happens to point at), so no
 * extra resolution is needed here.
 */
async function resolveRecordedContextAugmentationConfig(
  cwd: string,
  auth: ResolvedAuth,
): Promise<RecordedContextAugmentationConfig> {
  const discovered = await discoverProject(cwd, {
    auth,
    silent: true,
    console: new TerminalConsole(),
  });
  if (!discovered.projectKey) {
    return {};
  }
  return {
    organization: discovered.organization,
    projectKey: discovered.projectKey,
    serverUrl: discovered.serverUrl,
    workspaceDir: discovered.projectRoot,
  };
}

async function resolveContextToken(
  auth: ResolvedAuth,
  serverUrl: string,
  organization: string | undefined,
): Promise<string> {
  if (auth.serverUrl === serverUrl && auth.orgKey === organization) {
    return auth.token;
  }

  const token = await getToken(serverUrl, organization);
  if (token) {
    return token;
  }

  const connection = organization ? `${serverUrl} (${organization})` : serverUrl;
  throw new CommandFailedError(
    `Not authenticated for the recorded Vortex Context connection: ${connection}.`,
    {
      remediationHint:
        'Run: sonar auth login, then re-run sonar integrate claude or sonar integrate copilot from this project.',
    },
  );
}

export interface RunContextPassthroughOptions {
  stdinPayload?: string;
}

export async function runContextPassthrough(
  action: string | undefined,
  args: string[],
  options: RunContextPassthroughOptions = {},
): Promise<void> {
  const binaryPath = resolveContextAugmentationBinaryPath() ?? 'sonar-context-augmentation';
  const { forwarded, isHelp } = buildForwardedArgs(action, args);

  let env: NodeJS.ProcessEnv;
  if (isHelp) {
    env = buildContextAugmentationEnv();
  } else {
    const auth = await resolveAuth();
    if (!auth) {
      throw new CommandFailedError('Not authenticated.', {
        remediationHint: 'Run: sonar auth login',
      });
    }
    const recordedConfig = await resolveRecordedContextAugmentationConfig(process.cwd(), auth);
    const serverUrl = recordedConfig.serverUrl ?? auth.serverUrl;
    const organization = recordedConfig.organization ?? auth.orgKey;
    env = buildContextAugmentationEnv({
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
      child.stdin?.end(stdinPayload);
    }
  });
}
