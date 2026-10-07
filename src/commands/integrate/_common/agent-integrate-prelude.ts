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

// Shared preflight opening for agent integrate commands (claude, codex, copilot, cursor, antigravity, opencode).

import { homedir } from 'node:os';

import { isSonarQubeCloud, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { checkTokenStatus } from '@/core/auth/token.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { IntegrationScope } from '@/core/state/state.ts';
import type { Console } from '@/core/ui/console.ts';

/**
 * Shared preflight for all agent integrate commands: intro, cloud org check, then
 * token validation. Every agent integration installs globally, so no project is
 * discovered.
 */
export async function displayAgentIntegratePrelude(
  agentDisplayName: string,
  auth: ResolvedAuth,
  console: Console,
): Promise<void> {
  console.intro(`SonarQube Integration Setup for ${agentDisplayName}`);

  if (isSonarQubeCloud(auth.serverUrl) && !auth.orgKey) {
    throw new CommandFailedError('SonarQube Cloud requires an organization.', {
      remediationHint: "Run 'sonar auth login' with a SonarQube Cloud organization.",
    });
  }

  const tokenResult = await checkTokenStatus(auth.serverUrl, auth.token);
  if (tokenResult.status === 'unreachable') {
    console.outro('Setup failed', 'error');
    console.info('Server could not be reached.');
    console.text(
      '   Ensure the URL is correct and check your network connection or SONAR_HOST_URL.',
    );
    throw new CommandFailedError(
      tokenResult.errorMessage
        ? `Server is unreachable: ${tokenResult.errorMessage}`
        : 'Server is unreachable.',
    );
  }
  if (tokenResult.status === 'invalid') {
    throw new CommandFailedError('Token is invalid.', {
      remediationHint: "Run 'sonar auth login' to obtain a fresh token.",
    });
  }
}

/** Every agent integration installs to the user's home directory. */
export function resolveIntegrateInstallTarget(): {
  installRoot: string;
  installScope: IntegrationScope;
} {
  return { installRoot: homedir(), installScope: 'global' };
}
