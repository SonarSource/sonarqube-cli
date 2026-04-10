/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

export const normalizePath = (p: string): string => p.replaceAll('\\', '/');

export const IS_WINDOWS = process.platform === 'win32';
export const SCRIPT_EXT = IS_WINDOWS ? '.ps1' : '.sh';

/**
 * Build the HOME-related env vars needed to override a user's home directory.
 * On Windows both USERPROFILE and HOME are set because Git for Windows runs
 * hooks in MSYS2 bash, which derives HOME from HOMEDRIVE+HOMEPATH when HOME
 * is unset.
 */
export function buildHomeEnv(homePath: string): Record<string, string> {
  return IS_WINDOWS ? { USERPROFILE: homePath, HOME: homePath } : { HOME: homePath };
}

/**
 * Get the name of a hook script file (with extension)
 */
export function hookScriptName(name: string): string {
  return `${name}${SCRIPT_EXT}`;
}

/**
 * Extract the script path from a hook command string.
 * On Windows commands are wrapped as `powershell -NoProfile -File <path>`;
 * this strips that prefix. Always normalizes to forward slashes.
 */
export function hookScriptPath(command: string): string {
  const powershellPrefix = 'powershell -NoProfile -File ';
  const path = command.startsWith(powershellPrefix)
    ? command.slice(powershellPrefix.length)
    : command;
  return normalizePath(path);
}
