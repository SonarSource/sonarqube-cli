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

import { restoreEnv } from './isolated-cli-env.ts';

/** Every variable the network configuration reads, so a test never inherits the developer's. */
export const NETWORK_ENV_KEYS = [
  'SONAR_HTTP_PROXY_URL',
  'SONAR_HTTPS_PROXY_URL',
  'SONAR_NO_PROXY',
  'SONAR_CA_CERT',
  'SONAR_TLS_CLIENT_CERT',
  'SONAR_TLS_CLIENT_KEY_FILE',
  'SONAR_TLS_CLIENT_PASSPHRASE',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
];

/** Clears the network variables and returns the function that puts them back. */
export function isolateNetworkEnv(): () => void {
  const previous = Object.fromEntries(NETWORK_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of NETWORK_ENV_KEYS) delete process.env[key];
  return () => {
    for (const key of NETWORK_ENV_KEYS) restoreEnv(key, previous[key]);
  };
}
