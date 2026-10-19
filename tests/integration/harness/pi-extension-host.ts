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

import { join } from 'node:path';

import type { TestHarness } from './index.js';

const DRIVER_PATH = join(import.meta.dir, 'pi-extension-driver.ts');
const DEFAULT_SESSION_ID = 'ses_test';
const DRIVER_TIMEOUT_MS = 45000;

export type PiExtensionStep = { event: string; payload?: unknown } | { remove: string };

export interface PiExtensionOptions {
  processCwd?: string;
  sessionIdThrows?: boolean;
  entries?: unknown[];
  env?: Record<string, string>;
}

export interface PiExtensionRun {
  registered: string[];
  results: unknown[];
  sentMessages: unknown[];
}

export async function runPiExtension(
  harness: TestHarness,
  extensionPath: string,
  steps: PiExtensionStep[],
  options: PiExtensionOptions = {},
): Promise<PiExtensionRun> {
  const input = {
    extensionPath,
    cwd: harness.cwd.path,
    sessionId: DEFAULT_SESSION_ID,
    sessionIdThrows: options.sessionIdThrows,
    entries: options.entries,
    steps,
  };
  const proc = Bun.spawn([process.execPath, DRIVER_PATH], {
    cwd: options.processCwd ?? harness.cwd.path,
    env: harness.env({ extraEnv: options.env }),
    stdin: new Response(JSON.stringify(input)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), DRIVER_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`Pi extension driver failed with exit code ${exitCode}: ${stderr}`);
    }
    try {
      return JSON.parse(stdout) as PiExtensionRun;
    } catch {
      throw new Error(`Pi extension driver printed unexpected output: ${stdout}\n${stderr}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
