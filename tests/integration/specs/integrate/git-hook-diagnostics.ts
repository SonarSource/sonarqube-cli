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

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { SONAR_HOOK_SKIP_SECRETS_MESSAGE } from '@/commands/integrate/git/tools/shared.ts';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { buildLocalBinaryName } from '@/core/host/install/secrets.ts';

import type { TestHarness } from '../../harness';
import { IS_WINDOWS } from '../../harness/platform';

type GitHookKind = 'pre-commit' | 'pre-push';

type GitHookOutcomePath =
  | 'blocked-secret'
  | 'skipped-sonar-not-found'
  | 'scan-failed-soft'
  | 'inactive-unauthenticated'
  | 'inactive-secrets-binary-missing'
  | 'no-hook-output-probe-commit'
  | 'unknown';

export type GitHookDiagnosticContext = {
  harness: TestHarness;
  hookEnv: Record<string, string>;
  sonarBinDir: string;
  repoCwd: string;
  hook: GitHookKind;
  operation: string;
};

type SpawnLike = {
  exitCode: number | null;
  stdout: Uint8Array | undefined;
  stderr: Uint8Array | undefined;
};

function decodeSpawnOutput(part: Uint8Array | undefined): string {
  return part?.toString() ?? '';
}

export function formatSpawnOutput(result: SpawnLike): string {
  const stdout = decodeSpawnOutput(result.stdout);
  const stderr = decodeSpawnOutput(result.stderr);
  if (stdout && stderr) {
    return `[stdout]\n${stdout}\n[stderr]\n${stderr}`;
  }
  return stdout || stderr || '(empty)';
}

function gitConfigGet(
  cwd: string,
  env: Record<string, string>,
  scope: 'global' | 'local',
  key: string,
): string {
  const args = ['config', `--${scope}`, '--get', key];
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    return `(unset, git exit ${result.exitCode ?? 'null'})`;
  }
  return decodeSpawnOutput(result.stdout).trim() || '(empty)';
}

function probeShellBinaryResolution(env: Record<string, string>): string {
  const script = [
    'command -v sonar 2>&1 || true',
    'command -v sonar.exe 2>&1 || true',
    'printf "PATH=%s\\n" "$PATH"',
  ].join('; ');
  const result = Bun.spawnSync(['sh', '-c', script], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return formatSpawnOutput(result);
}

function classifyHookOutput(output: string, exitCode: number | null): GitHookOutcomePath {
  if (output.includes('Secrets detected')) {
    return 'blocked-secret';
  }
  if (output.includes(SONAR_HOOK_SKIP_SECRETS_MESSAGE)) {
    return 'skipped-sonar-not-found';
  }
  if (output.includes('Secrets scan failed') && output.includes('is not blocked')) {
    return 'scan-failed-soft';
  }
  if (output.includes('code scanning is inactive: not authenticated')) {
    return 'inactive-unauthenticated';
  }
  if (output.includes('secret scanning is inactive: analyzer not installed')) {
    return 'inactive-secrets-binary-missing';
  }
  if ((exitCode ?? 1) === 0 && output.trim() === '') {
    return 'no-hook-output-probe-commit';
  }
  return 'unknown';
}

function describeOutcomePath(path: GitHookOutcomePath): string {
  switch (path) {
    case 'blocked-secret':
      return 'Hook reported secrets and blocked the operation (expected on success).';
    case 'skipped-sonar-not-found':
      return 'Hook script exited 0 because `command -v sonar` found no binary (nativeBinBlock fail-open).';
    case 'scan-failed-soft':
      return 'Secrets scan threw; hook warn-and-continued because auth is not env-based (handleScanError fail-soft).';
    case 'inactive-unauthenticated':
      return 'Hook handler reported inactive/unauthenticated scanning.';
    case 'inactive-secrets-binary-missing':
      return 'Hook handler reported sonar-secrets analyzer missing.';
    case 'no-hook-output-probe-commit':
      return 'Operation succeeded with empty hook output — hook may not have run (check core.hooksPath).';
    case 'unknown':
      return 'Output did not match a known fail-open marker; inspect raw stdout/stderr below.';
  }
}

function fileProbe(path: string): string {
  if (!existsSync(path)) {
    return 'missing';
  }
  try {
    const mode = statSync(path).mode;
    const executable = (mode & 0o111) !== 0;
    return executable ? 'present, executable' : 'present, not executable';
  } catch (err) {
    return `present, stat failed: ${(err as Error).message}`;
  }
}

function probeDirectHookInvocation(
  context: GitHookDiagnosticContext,
  globalHooksPath: string,
): string {
  const hookScript = join(globalHooksPath, context.hook);
  if (!existsSync(hookScript)) {
    return `(hook script missing at ${hookScript})`;
  }
  const result = Bun.spawnSync(['sh', hookScript], {
    cwd: context.repoCwd,
    env: context.hookEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return [
    `direct ${context.hook} invocation exit=${result.exitCode ?? 'null'}`,
    formatSpawnOutput(result),
  ].join('\n');
}

export function buildGitHookDiagnostics(
  context: GitHookDiagnosticContext,
  result: SpawnLike,
): string {
  const output = formatSpawnOutput(result);
  const combined = decodeSpawnOutput(result.stdout) + decodeSpawnOutput(result.stderr);
  const outcome = classifyHookOutput(combined, result.exitCode);
  const globalHooksPath = gitConfigGet(
    context.repoCwd,
    context.hookEnv,
    'global',
    'core.hooksPath',
  );
  const localHooksPath = gitConfigGet(context.repoCwd, context.hookEnv, 'local', 'core.hooksPath');
  const sonarBinName = IS_WINDOWS ? 'sonar.exe' : 'sonar';
  const sonarBinPath = join(context.sonarBinDir, sonarBinName);
  const secretsBinPath = join(
    context.harness.cliHome.path,
    'bin',
    buildLocalBinaryName(detectPlatform()),
  );
  const globalHookScript = join(globalHooksPath, context.hook);
  const localHookScript = join(context.repoCwd, '.git', 'hooks', context.hook);

  const hookScriptHead = existsSync(globalHookScript)
    ? readFileSync(globalHookScript, 'utf-8').split('\n').slice(0, 12).join('\n')
    : '(global hook script not present)';

  return [
    '--- git hook diagnostic trace ---',
    `operation: ${context.operation}`,
    `hook: ${context.hook}`,
    `repo: ${context.repoCwd}`,
    `exit code: ${result.exitCode ?? 'null'}`,
    `classified path: ${outcome}`,
    `interpretation: ${describeOutcomePath(outcome)}`,
    '',
    'git config:',
    `  core.hooksPath (global): ${globalHooksPath}`,
    `  core.hooksPath (local): ${localHooksPath}`,
    '',
    'files:',
    `  global hook script (${globalHookScript}): ${fileProbe(globalHookScript)}`,
    `  local hook script (${localHookScript}): ${fileProbe(localHookScript)}`,
    `  sonar binary (${sonarBinPath}): ${fileProbe(sonarBinPath)}`,
    `  sonar-secrets in cli home (${secretsBinPath}): ${fileProbe(secretsBinPath)}`,
    '',
    'global hook script head:',
    hookScriptHead,
    '',
    'hook env (selected):',
    `  HOME=${context.hookEnv.HOME ?? context.hookEnv.USERPROFILE ?? '(unset)'}`,
    `  SONARQUBE_CLI_KEYCHAIN_FILE=${context.hookEnv.SONARQUBE_CLI_KEYCHAIN_FILE ?? '(unset)'}`,
    `  PATH=${context.hookEnv.PATH ?? '(unset)'}`,
    '',
    'shell probe (same env as git commit/push; mimics hook script lookup):',
    probeShellBinaryResolution(context.hookEnv),
    '',
    `direct hook script smoke test (cwd=${context.repoCwd}):`,
    globalHooksPath.startsWith('(')
      ? '(skipped — global core.hooksPath unset)'
      : probeDirectHookInvocation(context, globalHooksPath),
    '',
    `${context.operation} combined output:`,
    output,
    '--- end git hook diagnostic trace ---',
  ].join('\n');
}

export function assertGitHookBlockedSecret(
  result: SpawnLike,
  context: GitHookDiagnosticContext,
): void {
  const output = decodeSpawnOutput(result.stdout) + decodeSpawnOutput(result.stderr);
  const diagnostics = () => buildGitHookDiagnostics(context, result);

  if (result.exitCode === 0) {
    throw new Error(
      `Expected ${context.operation} to be blocked by the git hook, but it succeeded.\n\n${diagnostics()}`,
    );
  }
  if (!output.includes('Secrets detected')) {
    throw new Error(
      `Expected ${context.operation} hook output to contain "Secrets detected", but exit code was ${result.exitCode ?? 'null'}.\n\n${diagnostics()}`,
    );
  }
}
