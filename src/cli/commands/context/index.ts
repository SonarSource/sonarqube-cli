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
import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { resolveAuth, type ResolvedAuth } from '../../../lib/auth-resolver';
import { BIN_DIR, SONAR_CONTEXT_INVOCATION } from '../../../lib/config-constants';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '../../../lib/install-types';
import { getToken } from '../../../lib/keychain';
import logger from '../../../lib/logger';
import { detectPlatform } from '../../../lib/platform-detector';
import type { AgentExtension, SkillExtension } from '../../../lib/state';
import { loadState } from '../../../lib/state-manager';
import { buildContextAugmentationEnv } from '../_common/context-augmentation-env';
import { CommandFailedError } from '../_common/error';
import { buildLocalCagBinaryName } from '../_common/install/context-augmentation';

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

interface RecordedContextAugmentationConfig {
  organization?: string;
  projectKey?: string;
  serverUrl?: string;
}

function canonicalPath(path: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    canonical = resolve(path);
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function isPathInside(parent: string, child: string): boolean {
  if (child === parent) {
    return true;
  }
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function isProjectContextAugmentationSkill(extension: AgentExtension): extension is SkillExtension {
  // Global CAG skills are not tied to a project root, so they cannot provide passthrough context.
  return (
    extension.kind === 'skill' &&
    extension.name === CONTEXT_AUGMENTATION_BINARY_NAME &&
    !extension.global
  );
}

function resolveRecordedContextAugmentationConfig(cwd: string): RecordedContextAugmentationConfig {
  try {
    const current = canonicalPath(cwd);
    const matches = loadState()
      .agentExtensions.filter(isProjectContextAugmentationSkill)
      .map((extension) => ({
        extension,
        projectRoot: canonicalPath(extension.projectRoot),
      }))
      .filter(({ projectRoot }) => isPathInside(projectRoot, current))
      .sort(
        (a, b) =>
          b.projectRoot.length - a.projectRoot.length ||
          getUpdatedAtTimestamp(b.extension) - getUpdatedAtTimestamp(a.extension),
      );
    const match = matches.at(0)?.extension;
    if (!match) {
      return {};
    }
    return {
      organization: match.orgKey,
      projectKey: match.projectKey,
      serverUrl: match.serverUrl,
    };
  } catch (err) {
    logger.debug(
      `Failed to resolve recorded Context Augmentation config: ${(err as Error).message}`,
    );
    return {};
  }
}

function getUpdatedAtTimestamp(extension: SkillExtension): number {
  const timestamp = Date.parse(extension.updatedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
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
    `Not authenticated for the recorded Context Augmentation connection: ${connection}.`,
    {
      remediationHint:
        'Run: sonar auth login, then re-run sonar integrate claude or sonar integrate copilot from this project.',
    },
  );
}

export async function runContextPassthrough(
  action: string | undefined,
  args: string[],
): Promise<void> {
  const binaryPath = join(BIN_DIR, buildLocalCagBinaryName(detectPlatform()));
  const { forwarded, isHelp } = buildForwardedArgs(action, args);

  let env: NodeJS.ProcessEnv;
  if (isHelp) {
    env = process.env;
  } else {
    const auth = await resolveAuth();
    if (!auth) {
      throw new CommandFailedError('Not authenticated.', {
        remediationHint: 'Run: sonar auth login',
      });
    }
    const recordedConfig = resolveRecordedContextAugmentationConfig(process.cwd());
    const serverUrl = recordedConfig.serverUrl ?? auth.serverUrl;
    const organization = recordedConfig.organization ?? auth.orgKey;
    env = buildContextAugmentationEnv({
      organization,
      projectKey: recordedConfig.projectKey,
      serverUrl,
      token: await resolveContextToken(auth, serverUrl, organization),
    });
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, forwarded, {
      stdio: 'inherit',
      env,
      argv0: SONAR_CONTEXT_INVOCATION,
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new CommandFailedError('Context Augmentation is not installed.', {
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
  });
}
