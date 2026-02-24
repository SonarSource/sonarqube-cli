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

// Cross-platform browser opening utility

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Open URL in default browser
 */
export async function openBrowser(url: string): Promise<void> {
  const os = platform();

  let command: string;
  let args: string[];

  switch (os) {
    case 'darwin':
      command = 'open';
      args = [url];
      break;
    case 'win32':
      command = 'rundll32';
      args = ['url.dll,FileProtocolHandler', url];
      break;
    default: // linux and others
      command = 'xdg-open';
      args = [url];
      break;
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      shell: false
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
