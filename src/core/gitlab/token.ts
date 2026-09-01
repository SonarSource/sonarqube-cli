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

import { CommandFailedError } from '@/core/command-error.ts';
import type { Console } from '@/core/ui/console.ts';

export async function resolveGitlabToken(console: Console): Promise<string> {
  const canPrompt = process.stdin.isTTY || Boolean(process.env.SONARQUBE_CLI_MOCK_TTY);
  const envToken = process.env.GITLAB_TOKEN;

  if (canPrompt) {
    const hint = envToken ? ' (press Enter to use GITLAB_TOKEN)' : '';
    const prompted = await console.passwordPrompt(`GitLab personal access token${hint}:`);
    if (prompted === null) {
      throw new CommandFailedError('GitLab token is required.');
    }
    if (prompted !== '') return prompted;
    if (envToken) return envToken;
    throw new CommandFailedError(
      'GitLab token required: provide one at the prompt or set the GITLAB_TOKEN environment variable.',
    );
  }

  if (envToken) return envToken;
  throw new CommandFailedError('GitLab token required: set the GITLAB_TOKEN environment variable.');
}
