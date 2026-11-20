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

import {
  assertValidServerUrl,
  isSonarQubeCloud,
  isValidServerUrl,
} from '@/core/auth/auth-resolver.ts';
import { CancelledByUserError } from '@/core/commands/command-error.ts';
import { SONARCLOUD_URL, SONARCLOUD_US_URL } from '@/core/config-constants.ts';
import { discoverServerFromConfig } from '@/core/project-discovery/project-info.ts';
import type { Console } from '@/core/ui/console.ts';

export interface ResolvedServer {
  server: string;
  /** Absolute path of the project file that supplied `server`, when one did. */
  configFile?: string;
}

export async function confirmServerTrust(
  server: string,
  console: Console,
  configFile?: string,
): Promise<void> {
  if (isSonarQubeCloud(server)) {
    return;
  }
  console.warn('Only connect to servers you trust.');
  const fromFile = configFile ? ` from ${configFile}` : '';
  const confirmed = await console.confirmPrompt(`Connect to: ${server}${fromFile}?`, false);
  if (!confirmed) {
    throw new CancelledByUserError('Login cancelled');
  }
}

export async function resolveServer(
  serverOption: string | undefined,
  console: Console,
): Promise<ResolvedServer> {
  if (serverOption) {
    assertValidServerUrl(
      serverOption,
      "Run 'sonar auth login' again and enter an HTTP(S) URL with a host.",
    );
    return { server: serverOption };
  }

  const discovered = await discoverServerFromConfig(console);
  if (discovered) {
    assertValidServerUrl(
      discovered.value,
      'Fix serverUrl in .sonar-config.json or pass --server <url>.',
    );
    return { server: discovered.value, configFile: discovered.configFile };
  }

  const server = await selectServerFromPrompt(console);
  assertValidServerUrl(
    server,
    "Run 'sonar auth login' again and enter an HTTP(S) URL with a host.",
  );
  return { server };
}

const SERVER_SELECTION_CANCELLED = 'Server selection cancelled';

async function selectServerFromPrompt(console: Console): Promise<string> {
  const serverType = await console
    .selectPromptResult('Where would you like to connect?', [
      { value: 'cloud', label: 'SonarQube Cloud' },
      { value: 'server', label: 'SonarQube Server (self-hosted)' },
    ])
    .onCancellation(SERVER_SELECTION_CANCELLED)
    .orThrow();

  if (serverType === 'cloud') {
    return console
      .selectPromptResult('Which SonarQube Cloud region?', [
        { value: SONARCLOUD_URL, label: 'EU (sonarcloud.io)' },
        { value: SONARCLOUD_US_URL, label: 'US (sonarqube.us)' },
      ])
      .onCancellation(SERVER_SELECTION_CANCELLED)
      .orThrow();
  }

  const url = await console
    .promptUntilValidResult(
      'Enter server URL',
      (v) => !!v.trim() && isValidServerUrl(v.trim()),
      'Please enter a valid URL (for example https://sonarqube.mycompany.com/sonarqube).',
    )
    .onCancellation(SERVER_SELECTION_CANCELLED)
    .orThrow();
  return url.trim();
}
