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

import { openBrowser } from '@/core/host/browser.ts';
import { measureUserWait } from '@/core/telemetry/user-wait.ts';

import type { Console } from './console.ts';

/**
 * Sends the user to `url` and waits until `wait` settles, counting the whole step as time spent
 * waiting on the user. Every step that waits for the user in a browser goes through here. `wait`
 * gets an unmeasured console, so a prompt during the step is not counted again.
 */
export function waitInBrowser<T>(
  url: string,
  console: Console,
  wait: (console: Console) => Promise<T>,
  open: (url: string) => Promise<void> = (target) => openBrowserWithFallback(target, console),
): Promise<T> {
  return measureUserWait(async () => {
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
