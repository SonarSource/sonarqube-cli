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

import { SONARCLOUD_HOSTNAME, SONARCLOUD_US_HOSTNAME } from '../config-constants.ts';
import { cloudRegionFromUrl } from './sonarcloud-region.ts';

export const INVALID_SERVER_URL_MESSAGE =
  'The SonarQube server URL must be an absolute HTTP(S) URL with a host and no control characters or embedded credentials.';

export function invalidCloudServerUrlMessage(): string {
  return `The SonarQube Cloud server URL host must be ${SONARCLOUD_HOSTNAME} or ${SONARCLOUD_US_HOSTNAME}.`;
}

function parseHttpServerUrl(serverUrl: string): URL | undefined {
  if (/[\u0000-\u001F\u007F]/.test(serverUrl)) {
    return undefined;
  }

  try {
    const url = new URL(serverUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    if (url.hostname.length === 0) {
      return undefined;
    }
    if (url.username !== '' || url.password !== '') {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

export function isValidServerUrl(serverUrl: string): boolean {
  return parseHttpServerUrl(serverUrl) !== undefined;
}

export function isValidCloudServerUrl(serverUrl: string): boolean {
  return isValidServerUrl(serverUrl) && cloudRegionFromUrl(serverUrl) !== undefined;
}
