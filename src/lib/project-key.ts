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

import { red } from '../ui/colors.ts';

const PROJECT_KEY_REGEX = /^[a-zA-Z0-9\-_.:]{1,400}$/;

export const PROJECT_KEY_VALIDATION_ERROR = red(
  'Project key may only contain letters, digits, dash, underscore, period, or colon, and must be at most 400 characters.',
);

export function isValidProjectKey(key: string): boolean {
  return PROJECT_KEY_REGEX.test(key);
}
