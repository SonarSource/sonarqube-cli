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
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';

import { runSecretsAllowlistCommand } from './spawn-secrets-cli.ts';

/**
 * Refuses to run outside a real interactive terminal, with no bypass flag. This is the one
 * deliberate safety gate in `sonar allowlist secrets`: it stops an agent from silently
 * "resolving" its own secrets-detection block by piping a flagged value into `add` without a
 * human ever reviewing the exposure.
 */
export async function allowlistSecretsAdd(ctx: CommandInvocationContext): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new CommandFailedError(
      'sonar allowlist secrets add requires a human at an interactive terminal; it cannot be run by an agent or script.',
      {
        remediationHint:
          'Open a terminal and run this command there. Coding agents cannot add allowlist entries on your behalf.',
      },
    );
  }
  await runSecretsAllowlistCommand(['add'], ctx.console);
}
