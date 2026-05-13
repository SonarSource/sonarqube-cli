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

/**
 * Base class for all CLI errors that carry an exit code.
 * runCommand reads exitCode from any subclass — no instanceof checks needed per type.
 */
export abstract class CliError extends Error {
  abstract readonly exitCode: number;
  readonly remediationHint?: string;

  protected constructor(message: string, remediationHint?: string) {
    super(message);
    this.remediationHint = remediationHint;
  }
}

/**
 * Thrown when the user provides invalid or conflicting command options.
 * Always exits with code 2.
 */
export class InvalidOptionError extends CliError {
  readonly exitCode = 2;
  constructor(reason: string, remediationHint?: string) {
    super(reason, remediationHint);
    this.name = 'InvalidOptionError';
  }
}

export interface CommandFailedErrorOptions {
  exitCode?: number;
  remediationHint?: string;
}

/**
 * Thrown when the command (and options if any defined) are valid, but it failed to execute.
 * Defaults to exit code 1; pass a custom code when needed.
 */
export class CommandFailedError extends CliError {
  readonly exitCode: number;
  constructor(message: string, options?: CommandFailedErrorOptions) {
    super(message, options?.remediationHint);
    this.name = 'CommandFailedError';
    this.exitCode = options?.exitCode ?? 1;
  }
}
