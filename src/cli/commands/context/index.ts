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
// injected via the SONAR_TOKEN env var (one of the three tokens CAG accepts).

import { spawn } from 'node:child_process';

import type { ResolvedAuth } from '../../../lib/auth-resolver';
import { CommandFailedError } from '../_common/error';
import { resolveContextAugmentationBinaryPath } from '../_common/install/context-augmentation';

export async function runContextPassthrough(auth: ResolvedAuth, args: string[]): Promise<void> {
  const binaryPath = resolveContextAugmentationBinaryPath();
  if (!binaryPath) {
    throw new CommandFailedError(
      'Context Augmentation is not installed. Run "sonar integrate claude" or "sonar integrate copilot" to install it.',
    );
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      stdio: 'inherit',
      env: { ...process.env, SONAR_TOKEN: auth.token },
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}
