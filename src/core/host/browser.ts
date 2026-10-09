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

import { CommandFailedError } from '@/core/commands/command-error.ts';

/**
 * Open URL in default browser
 */
export async function openBrowser(url: string, spawnProcess: typeof spawn = spawn): Promise<void> {
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
    const proc = spawnProcess(command, args, {
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

    proc.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new CommandFailedError(
            `Browser opener failed (${command}: ${signal ?? code ?? 'unknown exit'}).`,
          ),
        );
    });

    // Keep the short-lived opener referenced until its result is confirmed.
  });
}
