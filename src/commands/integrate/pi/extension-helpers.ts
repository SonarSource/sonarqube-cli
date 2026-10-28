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

export const PI_EXTENSION_HELPERS = String.raw`import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_TIMEOUT_MS = 60000;
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function runHook<T>(subcommand: string, payload: unknown, timeout: number = HOOK_TIMEOUT_MS, cwd?: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile('sonar', ['hook', ...subcommand.split(' ')], { timeout, cwd }, (error, stdout) => {
      if (error) return reject(error);
      try {
        resolvePromise(JSON.parse(stdout) as T);
      } catch (parseError) {
        reject(parseError);
      }
    });
    child.stdin?.end(JSON.stringify(payload));
  });
}

function resolveToCwd(path: string, cwd: string): string {
  let normalized = path.replace(UNICODE_SPACES, ' ');
  if (normalized.startsWith('@')) normalized = normalized.slice(1);
  if (normalized === '~') {
    normalized = homedir();
  } else if (normalized.startsWith('~/')) {
    normalized = join(homedir(), normalized.slice(2));
  } else if (/^file:\/\//.test(normalized)) {
    normalized = fileURLToPath(normalized);
  }
  return resolve(cwd, normalized);
}
`;
