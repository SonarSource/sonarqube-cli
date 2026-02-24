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

// Process management helpers

import { spawn } from 'node:child_process';

type StdioMode = 'pipe' | 'ignore' | 'inherit';

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: StdioMode;
  stdout?: StdioMode;
  stderr?: StdioMode;
  detached?: boolean;
}

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn process and wait for completion
 */
export async function spawnProcess(
  command: string,
  args: string[],
  options: SpawnOptions = {}
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [
        options.stdin || 'ignore',
        options.stdout || 'pipe',
        options.stderr || 'pipe'
      ],
      detached: options.detached || false
    });

    let stdout = '';
    let stderr = '';

    if (proc.stdout) {
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    proc.on('error', reject);

    proc.on('exit', (code) => {
      resolve({
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}
