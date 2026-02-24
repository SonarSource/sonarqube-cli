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

/**
 * Thrown when the user provides invalid or conflicting command options.
 */
export class InvalidOptionError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidOptionError';
  }
}

/**
 * Thrown when the command (and options if any defined) are valid, but it failed to execute.
 */
export class CommandFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandFailedError';
  }
}
