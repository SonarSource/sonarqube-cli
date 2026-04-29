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

import { type ResolvedAuth, resolveFromEndpoint } from '../../../../lib/auth-resolver.ts';
import { SONARCLOUD_SCA_SCANNER_CDN_URL } from '../../../../lib/config-constants.ts';

export interface ScaUrls {
  apiBaseUrl: string;
  downloadBaseUrl: string;
}

export function buildScaUrls(auth: ResolvedAuth): ScaUrls {
  if (auth.connectionType === 'cloud') {
    return {
      apiBaseUrl: `${resolveFromEndpoint(auth.serverUrl, '/sca')}/sca`,
      downloadBaseUrl: SONARCLOUD_SCA_SCANNER_CDN_URL,
    };
  }
  const base = resolveFromEndpoint(auth.serverUrl, '/api/v2/sca');
  return {
    apiBaseUrl: `${base}/api/v2/sca`,
    downloadBaseUrl: `${base}/api/v2/sca/clis`,
  };
}
