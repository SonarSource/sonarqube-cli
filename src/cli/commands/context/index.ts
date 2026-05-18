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
import { join } from 'node:path';

import { resolveAuth } from '../../../lib/auth-resolver';
import { BIN_DIR, SONAR_CONTEXT_INVOCATION } from '../../../lib/config-constants';
import { detectPlatform } from '../../../lib/platform-detector';
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
    env = { ...process.env, SONAR_TOKEN: auth.token };
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
