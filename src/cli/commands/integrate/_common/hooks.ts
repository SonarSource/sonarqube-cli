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

// Shared hook helpers used by both the Claude and Copilot integrations.
// Keeps script body templates, the cross-platform script writer, and the
// JSON config read-or-init helper in one place so the two integrations stay
// behaviorally aligned.

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SONAR_SECRETS_MARKER = 'sonar-secrets';

export const UNIX_SONAR_COMMAND_GUARD = `if ! command -v sonar &> /dev/null; then
  exit 0
fi`;

export const WINDOWS_SONAR_COMMAND_GUARD = `if (-not (Get-Command sonar -ErrorAction SilentlyContinue)) {
    exit 0
}`;

export function unixTemplate(command: string): string {
  return `#!/bin/bash\n${UNIX_SONAR_COMMAND_GUARD}\n${command}\n`;
}

export function windowsTemplate(command: string): string {
  return `${WINDOWS_SONAR_COMMAND_GUARD}\n$stdinData = [Console]::In.ReadToEnd()\n$stdinData | & ${command}\n`;
}

/**
 * Write a hook script for the current platform (`.sh` on Unix, `.ps1` on
 * Windows), creating `scriptDir` if needed. Returns the absolute path of
 * the script that was written.
 */
export async function writeHookScript(
  scriptDir: string,
  basename: string,
  unixContent: string,
  windowsContent: string,
): Promise<string> {
  const isWindows = process.platform === 'win32';
  const ext = isWindows ? '.ps1' : '.sh';
  const scriptPath = join(scriptDir, `${basename}${ext}`);
  mkdirSync(scriptDir, { recursive: true });
  await writeFile(
    scriptPath,
    isWindows ? windowsContent : unixContent,
    isWindows ? undefined : { mode: 0o755 },
  );
  return scriptPath;
}

/**
 * Read a JSON file at `path`, returning `defaultValue` when the file does
 * not exist or cannot be parsed. Used for hook config files that may be
 * missing or corrupted on a fresh install.
 */
export async function readOrInitJson<T>(path: string, defaultValue: T): Promise<T> {
  if (!existsSync(path)) return defaultValue;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return defaultValue;
  }
}
