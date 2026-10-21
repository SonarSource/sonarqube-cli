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

const DRIVER_PATH = join(import.meta.dir, 'opencode-plugin-driver.ts');
const DRIVER_TIMEOUT_MS = 45000;
const DEFAULT_SESSION_ID = 'ses_test';

export interface OpenCodePluginStep {
  hook: 'tool.execute.before' | 'tool.execute.after' | 'session.prompt';
  event: Record<string, unknown>;
}

export interface OpenCodePluginOptions {
  processCwd?: string;
  env?: Record<string, string>;
}

export interface OpenCodePluginStepResult {
  error: string | null;
  event: Record<string, any>;
}

export interface OpenCodePluginRun {
  id: string;
  registered: string[];
  results: OpenCodePluginStepResult[];
}

export function readEvent(tool: string, input: Record<string, unknown>): OpenCodePluginStep {
  return { hook: 'tool.execute.before', event: { tool, sessionID: DEFAULT_SESSION_ID, input } };
}

export function completedEvent(
  tool: string,
  input: Record<string, unknown>,
  content: unknown,
): OpenCodePluginStep {
  return {
    hook: 'tool.execute.after',
    event: { tool, sessionID: DEFAULT_SESSION_ID, input, status: 'completed', result: { content } },
  };
}

export function promptEvent(
  text: string,
  attachments: Record<string, unknown> = {},
): OpenCodePluginStep {
  return {
    hook: 'session.prompt',
    event: { sessionID: DEFAULT_SESSION_ID, prompt: { text, ...attachments } },
  };
}

export async function runOpenCodePlugin(
  harness: TestHarness,
  pluginPath: string,
  steps: OpenCodePluginStep[],
  options: OpenCodePluginOptions = {},
): Promise<OpenCodePluginRun> {
  const input = { pluginPath, directory: harness.cwd.path, steps };
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
      throw new Error(`OpenCode plugin driver failed with exit code ${exitCode}: ${stderr}`);
    }
    if (stderr.trim() !== '') {
      throw new Error(`OpenCode plugin driver reported an unhandled error: ${stderr}`);
    }
    try {
      return JSON.parse(stdout) as OpenCodePluginRun;
    } catch {
      throw new Error(`OpenCode plugin driver printed unexpected output: ${stdout}\n${stderr}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
