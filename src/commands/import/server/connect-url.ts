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

import type { DopSetting } from './server-import-api.ts';

const CREATE_PROJECT_PATH = '/projects/create';

export interface ConnectUrlOptions {
  /** Asks the web UI to discard the stored token and prompt for a new one. */
  resetPat?: boolean;
}

/**
 * The web UI page where the user connects (or reconnects) their personal access token for a
 * DevOps platform setting. The CLI never handles the token itself; it only points the user here.
 *
 * `dopSetting` is added for GitHub only: its connection flow is per setting, while the other
 * platforms are selected by `mode` alone.
 */
export function buildConnectUrl(
  serverUrl: string,
  setting: Pick<DopSetting, 'id' | 'type'>,
  options: ConnectUrlOptions = {},
): string {
  const params = new URLSearchParams({ mode: setting.type });
  if (setting.type === 'github') {
    params.set('dopSetting', setting.id);
  }
  if (options.resetPat) {
    params.set('resetPat', '1');
  }
  return `${serverUrl.replace(/\/$/, '')}${CREATE_PROJECT_PATH}?${params.toString()}`;
}
