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
import type { Console } from '@/core/ui/console.ts';

export async function resolveDevOpsToken(
  console: Console,
  platform: 'GitLab' | 'GitHub',
): Promise<string> {
  const envName = `${platform.toUpperCase()}_TOKEN`;
  const envToken = process.env[envName];

  if (console.canPrompt()) {
    const hint = envToken ? ` (press Enter to use ${envName})` : '';
    const prompted = await console.passwordPrompt(`${platform} personal access token${hint}:`);
    if (prompted === null) {
      throw new CommandFailedError(`${platform} token is required.`);
    }
    if (prompted !== '') return prompted;
    if (envToken) return envToken;
    throw new CommandFailedError(
      `${platform} token required: provide one at the prompt or set the ${envName} environment variable.`,
    );
  }

  if (envToken) return envToken;
  throw new CommandFailedError(
    `${platform} token required: set the ${envName} environment variable.`,
  );
}
