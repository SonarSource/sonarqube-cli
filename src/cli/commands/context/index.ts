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

// `sonar context` — passthrough wrapper to the locally installed
// sonar-context-augmentation binary. Forwards args verbatim, inherits stdio so
// the child owns the user-facing output, and propagates the exit code. Auth is
// injected via the SONAR_TOKEN env var for non-help invocations; --help and -h
// are forwarded without auth so users can read docs without being logged in.

import { spawn } from 'node:child_process';

import { resolveAuth } from '../../../lib/auth-resolver';
import { CommandFailedError } from '../_common/error';
import { resolveContextAugmentationBinaryPath } from '../_common/install/context-augmentation';

export async function runContextPassthrough(
  action: string | undefined,
  args: string[],
): Promise<void> {
  const binaryPath = resolveContextAugmentationBinaryPath();
  if (!binaryPath) {
    throw new CommandFailedError(
      'Context Augmentation is not installed. Run "sonar integrate claude" or "sonar integrate copilot" to install it.',
    );
  }

  // Build the argv to forward: bare `sonar context` defaults to --help.
  let forwarded: string[];
  if (action) {
    forwarded = [action, ...args];
  } else if (args.length > 0) {
    forwarded = args;
  } else {
    forwarded = ['--help'];
  }

  // Skip auth for top-level help requests. Commander may assign --help / -h to
  // the optional [action] positional on some platforms instead of routing them
  // to args, so we check both places.
  const isTopLevelHelp = action === '--help' || action === '-h' || !action;
  let env: NodeJS.ProcessEnv;
  if (isTopLevelHelp) {
    // Strip any ambient SONAR_TOKEN so we don't leak credentials for static
    // top-level help output.
    const { SONAR_TOKEN: _token, ...envWithoutToken } = process.env;
    env = envWithoutToken;
  } else {
    // A real action was given — inject auth so CAG has full context.
    const auth = await resolveAuth();
    if (!auth) {
      throw new CommandFailedError('Not authenticated. Run: sonar auth login');
    }
    env = { ...process.env, SONAR_TOKEN: auth.token };
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, forwarded, { stdio: 'inherit', env, argv0: 'sonar context' });

    child.on('error', reject);
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}
