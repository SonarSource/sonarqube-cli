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

import { homedir } from 'node:os';
import { join } from 'node:path';

const DEVIN_DIR_NAME = 'devin';

/**
 * Devin CLI config directory: `~/.config/devin` on macOS and Linux, `%APPDATA%\devin` on Windows.
 * Shared by agent detection and every Devin integration resource path.
 */
export function resolveDevinConfigDir(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), DEVIN_DIR_NAME);
  }
  return join(home, '.config', DEVIN_DIR_NAME);
}
