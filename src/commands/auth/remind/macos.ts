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

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { spawnProcess } from '@/core/process/process.ts';
import type { Console } from '@/core/ui/console.ts';

import {
  findExecutable,
  type LoginReminder,
  NOTIFICATION_TIMEOUT_SECONDS,
  POSIX_USER_SHELL_PREFIX,
  type ReminderNotifier,
  runWithInheritedOutput,
  shellQuote,
} from './shared.ts';

const ALERTER_GROUP = 'sonarqube-cli-login';
const ALERTER_EXTRA_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin'];

interface ConsoleUser {
  name: string;
  uid: string;
}

export interface MacOsNotifierOptions {
  useAlerter: boolean;
  console: Console;
}

export function createMacOsNotifier({
  useAlerter,
  console,
}: MacOsNotifierOptions): ReminderNotifier {
  return {
    isElevated: () => Promise.resolve(process.getuid?.() === 0),

    async handOffToConsoleUser(argv) {
      const user = await resolveConsoleUser();
      if (!user) {
        console.print('No console user logged in -- skipping notification.');
        return;
      }
      await runWithInheritedOutput('/bin/launchctl', [
        'asuser',
        user.uid,
        '/usr/bin/sudo',
        '-H',
        '-u',
        user.name,
        ...POSIX_USER_SHELL_PREFIX,
        ...argv,
      ]);
    },

    async notify(reminder) {
      const clicked = useAlerter ? await showAlerter(reminder) : await showDialog(reminder);
      if (clicked) {
        await openInTerminal(reminder.loginArgv);
      }
    },
  };
}

async function resolveConsoleUser(): Promise<ConsoleUser | null> {
  const { stdout: name } = await spawnProcess('/usr/bin/stat', ['-f', '%Su', '/dev/console']);
  if (!name || name === 'root' || name === 'loginwindow') {
    return null;
  }
  const { stdout: uid } = await spawnProcess('/usr/bin/id', ['-u', name]);
  return { name, uid };
}

async function showDialog(reminder: LoginReminder): Promise<boolean> {
  const script =
    `display dialog ${appleScriptString(reminder.message)} with title ${appleScriptString(reminder.title)} ` +
    `buttons {"Dismiss", "Run"} default button "Run" giving up after ${NOTIFICATION_TIMEOUT_SECONDS}`;
  const { stdout } = await spawnProcess('/usr/bin/osascript', ['-e', script]);
  return stdout.includes('button returned:Run') && stdout.includes('gave up:false');
}

async function showAlerter(reminder: LoginReminder): Promise<boolean> {
  const alerter = findExecutable('alerter', ALERTER_EXTRA_DIRECTORIES);
  if (!alerter) {
    throw new CommandFailedError('The alerter binary was not found.', {
      remediationHint: 'Install it with: brew install vjeantet/tap/alerter',
    });
  }
  const { stdout } = await spawnProcess(alerter, [
    '--title',
    reminder.title,
    '--message',
    reminder.message,
    '--timeout',
    String(NOTIFICATION_TIMEOUT_SECONDS),
    '--group',
    ALERTER_GROUP,
  ]);
  return /@(CONTENT|ACTION)CLICKED/.test(stdout);
}

async function openInTerminal(argv: string[]): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'sonar-remind-'));
  const script = join(directory, 'login.command');
  await writeFile(
    script,
    `#!/bin/bash\n${argv.map(shellQuote).join(' ')}\nrm -rf -- ${shellQuote(directory)}\n`,
    { mode: 0o700 },
  );
  await spawnProcess('/usr/bin/open', [script]);
}

function appleScriptString(value: string): string {
  const escaped = value.replaceAll(/[\\"]/g, String.raw`\$&`);
  return `"${escaped}"`;
}
