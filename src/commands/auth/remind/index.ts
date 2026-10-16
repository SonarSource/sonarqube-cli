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

import { checkTokenStatus } from '@/core/auth/token.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import type { Console } from '@/core/ui/console.ts';

import { createLinuxNotifier } from './linux.ts';
import { createMacOsNotifier } from './macos.ts';
import {
  NOTIFICATION_MESSAGE,
  NOTIFICATION_TITLE,
  type ReminderNotifier,
  selfInvocation,
} from './shared.ts';
import { createWindowsNotifier } from './windows.ts';

export interface AuthRemindLoginOptions {
  alerter?: boolean;
}

/**
 * Shows a native OS notification that starts `sonar auth login` in a terminal when clicked, unless the
 * user is already signed in. When run as root / SYSTEM (for example from an MDM script) it re-runs
 * itself inside the active console user's graphical session, where the sign-in state is checked.
 */
export async function authRemindLogin(
  options: AuthRemindLoginOptions,
  ctx: CommandInvocationContext,
): Promise<void> {
  const notifier = createNotifier(options, ctx.console);
  if (await notifier.isElevated()) {
    const alerterFlag = options.alerter ? ['--alerter'] : [];
    await notifier.handOffToConsoleUser([
      ...selfInvocation(),
      'auth',
      'remind-login',
      ...alerterFlag,
    ]);
    return;
  }
  if (await isSignedIn(ctx)) {
    ctx.console.print('Already authenticated -- skipping notification.');
    return;
  }
  await notifier.notify({
    title: NOTIFICATION_TITLE,
    message: NOTIFICATION_MESSAGE,
    loginArgv: [...selfInvocation(), 'auth', 'login'],
  });
}

function createNotifier(options: AuthRemindLoginOptions, console: Console): ReminderNotifier {
  if (options.alerter && process.platform !== 'darwin') {
    throw new InvalidOptionError('--alerter is supported on macOS only.');
  }
  if (process.platform === 'darwin') {
    return createMacOsNotifier({ useAlerter: options.alerter === true, console });
  }
  if (process.platform === 'linux') {
    return createLinuxNotifier(console);
  }
  if (process.platform === 'win32') {
    return createWindowsNotifier();
  }
  throw new CommandFailedError(`Login reminders are not supported on ${process.platform}.`);
}

async function isSignedIn(ctx: CommandInvocationContext): Promise<boolean> {
  const auth = await ctx.resolveAuthOrNull({ silent: true });
  if (!auth) {
    return false;
  }
  const { status } = await checkTokenStatus(auth.serverUrl, auth.token);
  return status !== 'invalid';
}
