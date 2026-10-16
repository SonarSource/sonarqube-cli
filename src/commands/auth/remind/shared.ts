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

import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { spawnProcess } from '@/core/process/process.ts';

export const NOTIFICATION_TITLE = 'SonarQube CLI';
export const NOTIFICATION_MESSAGE = 'You are not signed in. Click to run: sonar auth login';
export const NOTIFICATION_TIMEOUT_SECONDS = 60;

export const POSIX_USER_SHELL_PREFIX = [
  '/bin/bash',
  '-c',
  'cd "$HOME" 2>/dev/null || cd /tmp 2>/dev/null || true; ulimit -n 10240 2>/dev/null || true; exec "$@"',
  'bash',
];

export interface LoginReminder {
  title: string;
  message: string;
  /** Full argv of the command that a click on the notification runs in a terminal. */
  loginArgv: string[];
}

export interface ReminderNotifier {
  /**
   * Tells whether this process runs as root / SYSTEM, which has no graphical session of its own.
   *
   * @returns `true` when the notification has to be handed off to the console user.
   */
  isElevated(): Promise<boolean>;

  /**
   * Re-runs the CLI inside the active console user's graphical session and waits for it to finish.
   * Does nothing when nobody is logged in graphically.
   *
   * @param argv full argv to execute as the console user.
   */
  handOffToConsoleUser(argv: string[]): Promise<void>;

  /**
   * Shows the notification in the current user's session and, when the user clicks it,
   * opens a terminal running the login command. Returns after the click, dismissal or timeout.
   *
   * @param reminder text of the notification and the command a click runs.
   */
  notify(reminder: LoginReminder): Promise<void>;
}

/**
 * Argv prefix that re-invokes this CLI, whether running from source with Bun or as a compiled binary.
 */
export function selfInvocation(): string[] {
  const isDevMode = process.execPath.endsWith('bun');
  return isDevMode ? [process.execPath, process.argv[1]] : [process.execPath];
}

const ESCAPED_SINGLE_QUOTE = String.raw`'\''`;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", ESCAPED_SINGLE_QUOTE)}'`;
}

export function findExecutable(name: string, extraDirectories: string[]): string | null {
  const directories = [...(process.env.PATH ?? '').split(delimiter), ...extraDirectories];
  for (const directory of directories) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export async function runWithInheritedOutput(command: string, args: string[]): Promise<void> {
  const { exitCode } = await spawnProcess(command, args, { stdout: 'inherit', stderr: 'inherit' });
  if (exitCode !== 0) {
    throw new CommandFailedError(`${command} exited with code ${exitCode}.`);
  }
}
