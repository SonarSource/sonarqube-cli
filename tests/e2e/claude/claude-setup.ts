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

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { IS_WINDOWS } from '../../integration/harness';

const CLAUDE_CODE_API_KEY = process.env.CLAUDE_CODE_API_KEY;
const CLAUDE_INSTALL_TIMEOUT_MS = 60_000;

export interface SetupOptions {
  env: Record<string, string>;
}

interface ClaudeOutput {
  is_error: boolean;
  num_turns: number;
  result: string;
  subtype: string;
}

export function isClaudeCodeEnvSetup(): boolean {
  return Boolean(CLAUDE_CODE_API_KEY);
}

export function setupClaude(options: SetupOptions): Claude {
  const apiKey = CLAUDE_CODE_API_KEY;
  if (!apiKey) {
    throw new Error('CLAUDE_CODE_API_KEY is required to run Claude Code E2E tests');
  }

  const env = {
    ...options.env,
    ANTHROPIC_API_KEY: apiKey,
  };
  const claudeBinary = installClaudeCode({ ...options, env });
  return new Claude(claudeBinary, { ANTHROPIC_API_KEY: apiKey });
}

export interface ClaudeRunOptions {
  args?: string[];
  cwd: string;
  env: Record<string, string>;
}

export class Claude {
  constructor(
    private readonly claudeBinary: string,
    private readonly env: Record<string, string>,
  ) {}

  async run(prompt: string, options: ClaudeRunOptions) {
    const args = ['-p', '--output-format', 'json', ...(options.args ?? []), prompt];
    const proc = Bun.spawn([this.claudeBinary, ...args], {
      cwd: options.cwd,
      env: { ...options.env, ...this.env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const diagnostic = `${stdout}\n${stderr}`;
    let output: ClaudeOutput;
    try {
      output = JSON.parse(stdout) as ClaudeOutput;
    } catch (err) {
      throw new Error(
        `Claude did not emit JSON (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}\nparse error: ${
          (err as Error).message
        }`,
      );
    }

    if (output.subtype !== 'success') {
      throw new Error(diagnostic);
    }

    return { diagnostic, exitCode, output, stderr, stdout };
  }
}

function spawnSyncText(command: string[], env: Record<string, string>, timeoutMs: number) {
  const result = Bun.spawnSync(command, {
    env,
    timeout: timeoutMs,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: result.exitCode,
    timedOut: result.exitedDueToTimeout ?? false,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function installClaudeCode(options: SetupOptions): string {
  const env = options.env;
  const result = IS_WINDOWS
    ? spawnSyncText(
        [
          'powershell',
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          'irm https://claude.ai/install.ps1 | iex',
        ],
        env,
        CLAUDE_INSTALL_TIMEOUT_MS,
      )
    : spawnSyncText(
        ['/bin/bash', '-lc', 'curl -fsSL https://claude.ai/install.sh | bash'],
        env,
        CLAUDE_INSTALL_TIMEOUT_MS,
      );

  if (result.timedOut) {
    throw new Error(
      `Claude install timed out after ${CLAUDE_INSTALL_TIMEOUT_MS / 1000}s\nstdout:\n${
        result.stdout
      }\nstderr:\n${result.stderr}`,
    );
  }

  if (result.exitCode !== 0) {
    throw new Error(`Claude install failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }

  const homeDir = env['HOME'];
  const claudeBinary = join(homeDir, '.local', 'bin', IS_WINDOWS ? 'claude.exe' : 'claude');
  if (!existsSync(claudeBinary)) {
    throw new Error(
      [
        `Claude binary not found under ${homeDir}`,
        `Installer stdout:\n${result.stdout}`,
        `Installer stderr:\n${result.stderr}`,
      ].join('\n\n'),
    );
  }
  return claudeBinary;
}
