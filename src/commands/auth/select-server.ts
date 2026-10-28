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
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { SONARCLOUD_URL, SONARCLOUD_US_URL } from '@/core/config-constants.ts';
import { discoverServer } from '@/core/project-discovery/project-info.ts';
import type { Console } from '@/core/ui/console.ts';

export async function confirmServerTrust(server: string, console: Console): Promise<void> {
  if (isSonarQubeCloud(server)) {
    return;
  }
  console.warn('Only connect to servers you trust.');
  const confirmed = await console.confirmPrompt(`Connect to: ${server}?`, true);
  if (!confirmed) {
    throw new CommandFailedError('Login cancelled');
  }
}

export async function resolveServer(
  serverOption: string | undefined,
  console: Console,
): Promise<string> {
  let server: string;
  if (serverOption) {
    server = serverOption;
  } else {
    const configServer = await discoverServer(console);
    if (configServer) {
      assertValidServerUrl(
        configServer,
        'Fix serverUrl in .sonar-config.json or pass --server <url>.',
      );
      return configServer;
    }
    server = await selectServerFromPrompt(console);
  }
  assertValidServerUrl(
    server,
    "Run 'sonar auth login' again and enter an HTTP(S) URL with a host.",
  );
  return server;
}

async function selectServerFromPrompt(console: Console): Promise<string> {
  const serverType = await console.selectPrompt('Where would you like to connect?', [
    { value: 'cloud', label: 'SonarQube Cloud' },
    { value: 'server', label: 'SonarQube Server (self-hosted)' },
  ]);

  if (serverType === null) {
    throw new CommandFailedError('Server selection cancelled');
  }

  if (serverType === 'cloud') {
    const region = await console.selectPrompt('Which SonarQube Cloud region?', [
      { value: SONARCLOUD_URL, label: 'EU (sonarcloud.io)' },
      { value: SONARCLOUD_US_URL, label: 'US (sonarqube.us)' },
    ]);
    if (region === null) {
      throw new CommandFailedError('Server selection cancelled');
    }
    return region;
  }

  const url = await console.promptUntilValid(
    'Enter server URL',
    (v) => !!v.trim() && isValidServerUrl(v.trim()),
    'Please enter a valid URL (for example https://sonarqube.mycompany.com/sonarqube).',
  );
  if (url === null) {
    throw new CommandFailedError('Server selection cancelled');
  }
  return url.trim();
}
