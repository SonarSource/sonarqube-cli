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

// Cross-platform browser opening utility

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

import type { Console } from '@/core/ui/console.ts';

/**
 * Open URL in default browser
 */
export async function openBrowser(url: string): Promise<void> {
  const os = platform();

  let command: string;
  let args: string[];

  if (os === 'darwin') {
    command = 'open';
    args = [url];
  } else if (os === 'win32') {
    command = 'rundll32';
    args = ['url.dll,FileProtocolHandler', url];
  } else {
    // linux and others
    command = 'xdg-open';
    args = [url];
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      shell: false,
    });

    proc.on('error', (error: NodeJS.ErrnoException) => {
      // Ignore if command not found (browser might not be available)
      if (error.code === 'ENOENT') {
        reject(new Error(`${command} not found on this system`));
      } else {
        reject(error);
      }
    });

    proc.on('exit', () => {
      // Exit code 0 or null means success, ignore non-zero exit codes
      resolve();
    });

    proc.unref();
  });
}

/**
 * Sends the user to `url` and waits until `wait` settles; the console counts the whole step as
 * time spent waiting on the user. Every step that waits for the user in a browser goes through
 * here. `wait` gets an unmeasured console, so a prompt during the step is not counted again.
 */
export function waitInBrowser<T>(
  url: string,
  console: Console,
  wait: (console: Console) => Promise<T>,
  open: (url: string) => Promise<void> = (target) => openBrowserWithFallback(target, console),
): Promise<T> {
  return console.measureWait(async () => {
    await open(url);
    return wait(console.unmeasured());
  });
}

/**
 * Opens the browser, printing a fallback when it cannot. Skipped in CI or when automatic browser
 * opening is disabled. A step that then waits for the user uses `waitInBrowser` instead.
 */
export async function openBrowserWithFallback(
  url: string,
  console: Console,
  browserOpener: (url: string) => Promise<void> = openBrowser,
): Promise<void> {
  if (process.env.CI === 'true') {
    return;
  }
  if (process.env.SONARQUBE_CLI_DISABLE_BROWSER === 'true') {
    console.print('Automatic browser opening is disabled; copy the URL above and open it manually');
    return;
  }
  try {
    await browserOpener(url);
  } catch (error) {
    console.warn(`Failed to open browser automatically: ${String(error)}`);
    console.print('Copy the URL above and open it manually');
  }
}
