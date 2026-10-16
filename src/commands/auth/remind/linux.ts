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

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

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

const NOTIFICATIONS_DESTINATION = 'org.freedesktop.Notifications';
const NOTIFICATIONS_PATH = '/org/freedesktop/Notifications';
const NOTIFICATION_SIGNALS_RULE = `type='signal',interface='${NOTIFICATIONS_DESTINATION}',path='${NOTIFICATIONS_PATH}'`;
const NOTIFICATION_ACTIONS = "['default', '', 'open', 'Open terminal']";
const GRAPHICAL_SESSION_TYPES = new Set(['x11', 'wayland', 'mir']);
const DEFAULT_DISPLAY = ':0';
const PASSWD_HOME_FIELD = 5;

const TERMINALS: ReadonlyArray<readonly [name: string, executeFlag: string[]]> = [
  ['xdg-terminal-exec', []],
  ['x-terminal-emulator', ['-e']],
  ['gnome-terminal', ['--']],
  ['konsole', ['-e']],
  ['xfce4-terminal', ['-x']],
  ['alacritty', ['-e']],
  ['xterm', ['-e']],
];

export interface NotificationEvent {
  kind: 'ActionInvoked' | 'NotificationClosed';
  id: number;
}

export function createLinuxNotifier(console: Console): ReminderNotifier {
  return {
    isElevated: () => Promise.resolve(process.getuid?.() === 0),

    async handOffToConsoleUser(argv) {
      const user = await findActiveGraphicalUser();
      if (!user) {
        console.print('No active graphical session found -- skipping notification.');
        return;
      }
      const uid = await readOutput('id', ['-u', user]);
      const home = (await readOutput('getent', ['passwd', user])).split(':')[PASSWD_HOME_FIELD];
      const display = await findDisplay(user);
      await runWithInheritedOutput('runuser', [
        '-u',
        user,
        '--',
        'env',
        `HOME=${home}`,
        `XDG_RUNTIME_DIR=/run/user/${uid}`,
        `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`,
        `DISPLAY=${display}`,
        ...POSIX_USER_SHELL_PREFIX,
        ...argv,
      ]);
    },

    async notify(reminder) {
      const capabilities = await gdbus('GetCapabilities');
      if (!capabilities.includes('actions')) {
        console.warn('The notification server may not support click actions.');
      }
      const id = await showNotification(reminder);
      if (await waitForClick(id, NOTIFICATION_TIMEOUT_SECONDS * 1000)) {
        openInTerminal(reminder.loginArgv);
      }
    },
  };
}

/**
 * Builds a stateful line parser for `dbus-monitor` output. The monitor prints each signal over several
 * lines, so the parser remembers which signal it is in and reports the notification id once it appears.
 *
 * @returns a function that takes one output line and returns the event it completes, if any.
 */
export function createNotificationEventParser(): (line: string) => NotificationEvent | null {
  let kind: NotificationEvent['kind'] | null = null;
  return (line) => {
    const member = /member=(ActionInvoked|NotificationClosed)\b/.exec(line);
    if (member) {
      kind = member[1] as NotificationEvent['kind'];
      return null;
    }
    if (/^(signal|method call) /.test(line)) {
      kind = null;
      return null;
    }
    const id = kind ? /uint32 (\d+)/.exec(line) : null;
    if (kind && id) {
      const event = { kind, id: Number(id[1]) };
      kind = null;
      return event;
    }
    return null;
  };
}

async function findActiveGraphicalUser(): Promise<string | null> {
  const sessions = await readOutput('loginctl', ['list-sessions', '--no-legend']).catch(() => '');
  for (const line of sessions.split('\n')) {
    const sessionId = line.trim().split(/\s+/)[0];
    if (!sessionId) continue;
    const properties = parseProperties(
      await readOutput('loginctl', [
        'show-session',
        sessionId,
        '-p',
        'Name',
        '-p',
        'State',
        '-p',
        'Type',
      ]),
    );
    if (properties.State === 'active' && GRAPHICAL_SESSION_TYPES.has(properties.Type)) {
      return properties.Name;
    }
  }
  return null;
}

async function findDisplay(user: string): Promise<string> {
  const pids = (await readOutput('pgrep', ['-u', user]).catch(() => ''))
    .split('\n')
    .filter(Boolean);
  for (const pid of pids) {
    const environment = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '');
    const display = /(?:^|\0)DISPLAY=([^\0]+)/.exec(environment)?.[1];
    if (display) return display;
  }
  return DEFAULT_DISPLAY;
}

async function showNotification(reminder: LoginReminder): Promise<number> {
  const output = await gdbus(
    'Notify',
    reminder.title,
    '0',
    '',
    reminder.title,
    reminder.message,
    NOTIFICATION_ACTIONS,
    '{}',
    String(NOTIFICATION_TIMEOUT_SECONDS * 1000),
  );
  const id = /uint32 (\d+)/.exec(output)?.[1];
  if (!id) {
    throw new CommandFailedError(`Unexpected reply from the notification server: ${output}`);
  }
  return Number(id);
}

function waitForClick(id: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const dbusMonitor = findExecutable('dbus-monitor', []);
    if (!dbusMonitor) {
      resolve(false);
      return;
    }
    const monitor = spawn(dbusMonitor, ['--session', NOTIFICATION_SIGNALS_RULE], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parseLine = createNotificationEventParser();
    const finish = (clicked: boolean): void => {
      clearTimeout(timer);
      monitor.kill();
      resolve(clicked);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    monitor.on('error', () => {
      finish(false);
    });
    createInterface({ input: monitor.stdout }).on('line', (line) => {
      const event = parseLine(line);
      if (event?.id === id) {
        finish(event.kind === 'ActionInvoked');
      }
    });
  });
}

function openInTerminal(argv: string[]): void {
  const shellCommand = `${argv.map(shellQuote).join(' ')}; exec bash`;
  for (const [name, executeFlag] of TERMINALS) {
    const terminal = findExecutable(name, []);
    if (!terminal) continue;
    spawn(terminal, [...executeFlag, 'bash', '-lc', shellCommand], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }
  throw new CommandFailedError('No terminal emulator found to run the login command.');
}

function gdbus(method: string, ...parameters: string[]): Promise<string> {
  return readOutput('gdbus', [
    'call',
    '--session',
    '--dest',
    NOTIFICATIONS_DESTINATION,
    '--object-path',
    NOTIFICATIONS_PATH,
    '--method',
    `${NOTIFICATIONS_DESTINATION}.${method}`,
    ...parameters,
  ]);
}

async function readOutput(command: string, args: string[]): Promise<string> {
  const { stdout } = await spawnProcess(command, args);
  return stdout;
}

function parseProperties(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}
