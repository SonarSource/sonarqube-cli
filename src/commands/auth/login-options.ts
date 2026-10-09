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

import { isSonarQubeCloud, isValidServerUrl } from '@/core/auth/auth-resolver.ts';
import { InvalidOptionError } from '@/core/commands/command-error.ts';

function validateNonInteractiveLogin(options: AuthLoginOptions): void {
  if (!options.nonInteractive || options.withToken) return;
  if (!options.server || !isSonarQubeCloud(options.server))
    throw new InvalidOptionError(
      '--non-interactive browser login requires an explicit SonarQube Cloud --server URL.',
    );
  if (options.organization !== false && !options.org)
    throw new InvalidOptionError(
      'Pass --org or --no-organization with --non-interactive browser login.',
    );
}

export function validateLoginOptions(options: AuthLoginOptions): void {
  validateNonInteractiveLogin(options);
  if (
    options.events &&
    (!options.nonInteractive || options.browser !== false || options.withToken)
  ) {
    throw new InvalidOptionError(
      '--events requires --non-interactive --no-browser and a browser login.',
    );
  }
  if (options.organization === false && options.org !== undefined) {
    throw new InvalidOptionError('--no-organization cannot be combined with --org.');
  }
  if (options.org !== undefined && !options.org.trim()) {
    throw new InvalidOptionError('--org value cannot be empty.', 'Use --org <organization-key>.');
  }

  if (options.server !== undefined && !options.server.trim()) {
    throw new InvalidOptionError(
      '--server value cannot be empty.',
      'Use --server <url> (for example https://sonarcloud.io).',
    );
  }

  if (options.server !== undefined && !isValidServerUrl(options.server)) {
    throw new InvalidOptionError(
      'Invalid server URL. It must be an absolute HTTP(S) URL with a host and no control characters.',
      'Use --server <url> (for example https://sonarcloud.io), or run sonar auth login without --server.',
    );
  }

  if (options.withToken && options.server === undefined) {
    throw new InvalidOptionError('--server is required with --with-token.', 'Use --server <url>.');
  }

  if (
    options.withToken &&
    options.server !== undefined &&
    isSonarQubeCloud(options.server) &&
    options.org === undefined &&
    options.organization !== false
  ) {
    throw new InvalidOptionError(
      '--org is required for SonarQube Cloud with --with-token.',
      'Use --org <organization-key>.',
    );
  }
}

export interface AuthLoginOptions {
  server?: string;
  org?: string;
  withToken?: boolean;
  organization?: boolean;
  nonInteractive?: boolean;
  force?: boolean;
  browser?: boolean;
  events?: boolean;
}
