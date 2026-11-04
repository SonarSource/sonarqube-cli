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

export const PROJECT_KEY_MAX_LENGTH = 400;

/** SonarQube project keys allowed when using a key into a generated hook shell script. */
export const PROJECT_KEY_SAFE_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/** SonarQube accepts keys of letters, digits and `-_.:`, at most 400 characters, with a non-digit. */
export function isValidProjectKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= PROJECT_KEY_MAX_LENGTH &&
    PROJECT_KEY_SAFE_PATTERN.test(key) &&
    !/^\d+$/.test(key)
  );
}
