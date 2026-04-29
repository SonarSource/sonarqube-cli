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

export interface SetupOptions {
  cwd: string;
  userHome: string;
  env: Record<string, string>;
}

interface ClaudeJsonResultBase {
  is_error: boolean;
  num_turns: number;
}

export interface ClaudeSuccessJsonResult extends ClaudeJsonResultBase {
  subtype: 'success';
  result: string;
}

export interface ClaudeErrorJsonResult extends ClaudeJsonResultBase {
  subtype: 'error_max_turns' | 'error_during_execution';
}

export type ClaudeJsonResult = ClaudeSuccessJsonResult | ClaudeErrorJsonResult;

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ClaudeRunResult extends ProcessResult {
  diagnostic: string;
  output: ClaudeJsonResult;
}

export interface SuccessfulClaudeRunResult extends ProcessResult {
  diagnostic: string;
  output: ClaudeSuccessJsonResult;
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

  async run(prompt: string, options: ClaudeRunOptions): Promise<SuccessfulClaudeRunResult> {
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

    const processResult = { exitCode, stdout, stderr };
    const result: ClaudeRunResult = {
      ...processResult,
      diagnostic: `${processResult.stdout}\n${processResult.stderr}`,
      output: this.parseClaudeJsonResult(processResult),
    };
    if (result.output.subtype !== 'success') {
      throw new Error(result.diagnostic);
    }
    return {
      ...result,
      output: result.output,
    };
  }

  private parseClaudeJsonResult(result: ProcessResult): ClaudeJsonResult {
    try {
      return JSON.parse(result.stdout) as ClaudeJsonResult;
    } catch (err) {
      throw new Error(
        `Claude did not emit JSON (exit ${result.exitCode})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\nparse error: ${
          (err as Error).message
        }`,
      );
    }
  }
}

function spawnSyncText(command: string[], env: Record<string, string>) {
  const result = Bun.spawnSync(command, {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: result.exitCode,
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
      )
    : spawnSyncText(['/bin/bash', '-lc', 'curl -fsSL https://claude.ai/install.sh | bash'], env);

  if (result.exitCode !== 0) {
    throw new Error(`Claude install failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }

  const claudeBinary = join(
    options.userHome,
    '.local',
    'bin',
    IS_WINDOWS ? 'claude.exe' : 'claude',
  );
  if (!existsSync(claudeBinary)) {
    throw new Error(
      [
        `Claude binary not found under ${options.userHome}`,
        `Installer stdout:\n${result.stdout}`,
        `Installer stderr:\n${result.stderr}`,
      ].join('\n\n'),
    );
  }
  return claudeBinary;
}
