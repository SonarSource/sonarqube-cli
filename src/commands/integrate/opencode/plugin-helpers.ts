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

export const OPENCODE_PLUGIN_HELPERS = String.raw`import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function runHook(subcommand: string, payload: unknown, timeout: number, cwd: string): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile('sonar', ['hook', subcommand], { timeout, cwd }, (error, stdout) => {
      if (error) return reject(error);
      try {
        resolvePromise(JSON.parse(stdout.trim().split('\n')[0]));
      } catch (parseError) {
        reject(parseError);
      }
    });
    child.stdin?.on('error', reject);
    child.stdin?.end(JSON.stringify(payload));
  });
}

function toFullPath(path: string, directory: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(directory, path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
`;
