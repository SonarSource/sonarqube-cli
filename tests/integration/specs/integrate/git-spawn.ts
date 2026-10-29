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

/** Central git subprocess helper for `integrate/git.test.ts`. */

export type GitSpawnResult = ReturnType<typeof Bun.spawnSync>;

export type GitSpawnOptions = {
  cwd: string;
  env?: Record<string, string>;
  /** Exit codes that must not throw (default: `[0]` only). */
  allowedExitCodes?: number[];
};

function decodeSpawnOutput(data: Uint8Array | string | undefined): string {
  if (data === undefined) return '';
  if (typeof data === 'string') return data;
  return new TextDecoder().decode(data);
}

function formatGitCommand(args: string[]): string {
  return `git ${args.join(' ')}`;
}

function gitFailureMessage(
  args: string[],
  cwd: string,
  exitCode: number | null,
  stdout: string,
  stderr: string,
): string {
  const sections = [
    `git command failed with exit code ${exitCode ?? 'null'}`,
    `  command: ${formatGitCommand(args)}`,
    `  cwd: ${cwd}`,
    '  stdout:',
    stdout.trim() === ''
      ? '    (empty)'
      : stdout
          .split(/\r?\n/)
          .map((line) => `    ${line}`)
          .join('\n'),
    '  stderr:',
    stderr.trim() === ''
      ? '    (empty)'
      : stderr
          .split(/\r?\n/)
          .map((line) => `    ${line}`)
          .join('\n'),
  ];
  return sections.join('\n');
}

/** Run `git` with centralized exit-code checking; throws with stdout/stderr on unexpected failure. */
export function gitSpawn(args: string[], options: GitSpawnOptions): GitSpawnResult {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: options.cwd,
    env: options.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = result.exitCode ?? 1;
  const allowed = options.allowedExitCodes ?? [0];
  if (!allowed.includes(exitCode)) {
    throw new Error(
      gitFailureMessage(
        args,
        options.cwd,
        result.exitCode,
        decodeSpawnOutput(result.stdout),
        decodeSpawnOutput(result.stderr),
      ),
    );
  }
  return result;
}

export function gitSpawnOutput(result: GitSpawnResult): string {
  return decodeSpawnOutput(result.stdout) + decodeSpawnOutput(result.stderr);
}
