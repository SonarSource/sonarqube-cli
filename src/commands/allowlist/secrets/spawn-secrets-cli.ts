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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { installSecretsBinary } from '@/core/host/install/secrets.ts';
import { spawnProcess } from '@/core/process/process.ts';
import type { Console } from '@/core/ui/console.ts';

/**
 * Resolve/install sonar-secrets, then run one of its `allowlist` subcommands with inherited
 * stdio so the binary's own prompts and output reach the user directly. No timeout: unlike
 * `analyze secrets`'s scans, `add`/`clear` can wait indefinitely on interactive input.
 */
export async function runSecretsAllowlistCommand(
  subcommandArgs: string[],
  console: Console,
): Promise<void> {
  const binaryPath = await installSecretsBinary(console);
  const result = await spawnProcess(binaryPath, ['allowlist', ...subcommandArgs], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = result.exitCode ?? 1;
  if (exitCode !== 0) {
    throw new CommandFailedError(
      `sonar-secrets allowlist ${subcommandArgs[0]} exited with code ${exitCode}`,
      { exitCode },
    );
  }
}
