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

import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
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
  | 'silent-no-staged-scan'
  | 'commit-succeeded-no-hook-signal'
  | 'pre-push-no-refs-fail-open'
  | 'last-commit-would-scan'
  | 'unknown';

/** Marker file written by chained-hook integration tests (see git.test.ts). */
const CHAINED_HOOK_MARKER_FILE = 'old-hook-ran.txt';

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

function gitSpawn(
  cwd: string,
  env: Record<string, string>,
  args: string[],
): { exitCode: number | null; output: string } {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    output: (decodeSpawnOutput(result.stdout) + decodeSpawnOutput(result.stderr)).trim(),
  };
}

function gitRevParse(cwd: string, env: Record<string, string>, flag: string): string {
  const { exitCode, output } = gitSpawn(cwd, env, ['rev-parse', flag]);
  if (exitCode !== 0) {
    return `(failed, git exit ${exitCode ?? 'null'}${output ? `: ${output}` : ''})`;
  }
  return output || '(empty)';
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

function sonarHookSubcommand(hook: GitHookKind): string {
  return hook === 'pre-commit' ? 'git-pre-commit' : 'git-pre-push';
}

function classifyHookOutput(
  output: string,
  exitCode: number | null,
  postMortem: {
    hook: GitHookKind;
    stagedFiles: string[];
    directSonarHookOutput: string;
    directSonarHookExit: number | null;
    lastCommitFiles: string[];
    lastCommitExplicitScanOutput: string;
    lastCommitExplicitScanExit: number | null;
    syntheticPrePushOutput: string;
    syntheticPrePushExit: number | null;
  },
): GitHookOutcomePath {
  if (output.includes('Secrets detected')) {
    return 'blocked-secret';
  }
  if (output.includes(SONAR_HOOK_SKIP_SECRETS_MESSAGE)) {
    return 'skipped-sonar-not-found';
  }
  if (output.includes('Secrets scan failed') && output.includes('is not blocked')) {
    return 'scan-failed-soft';
  }
  if (output.includes('scanning is inactive: not authenticated')) {
    return 'inactive-unauthenticated';
  }
  if (output.includes('secret scanning is inactive: analyzer not installed')) {
    return 'inactive-secrets-binary-missing';
  }
  if (
    postMortem.hook === 'pre-push' &&
    (postMortem.syntheticPrePushExit ?? 1) === 0 &&
    postMortem.syntheticPrePushOutput.trim() === '' &&
    (exitCode ?? 1) === 0
  ) {
    return 'pre-push-no-refs-fail-open';
  }
  if (
    postMortem.lastCommitFiles.length > 0 &&
    (postMortem.lastCommitExplicitScanExit ?? 1) !== 0 &&
    postMortem.lastCommitExplicitScanOutput.includes('Secrets detected')
  ) {
    return 'last-commit-would-scan';
  }
  if ((exitCode ?? 1) === 0 && output.trim() === '') {
    return 'no-hook-output-probe-commit';
  }
  if (
    postMortem.hook === 'pre-commit' &&
    (exitCode ?? 1) === 0 &&
    postMortem.stagedFiles.length === 0 &&
    (postMortem.directSonarHookExit ?? 1) === 0 &&
    postMortem.directSonarHookOutput.trim() === '' &&
    postMortem.lastCommitFiles.length > 0
  ) {
    return 'silent-no-staged-scan';
  }
  if (
    (exitCode ?? 1) === 0 &&
    !output.includes('Secrets detected') &&
    !output.includes(SONAR_HOOK_SKIP_SECRETS_MESSAGE) &&
    /\] wip|\] initial|create mode 100644/.test(output)
  ) {
    return 'commit-succeeded-no-hook-signal';
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
    case 'silent-no-staged-scan':
      return 'Commit landed but post-mortem shows empty index and silent `sonar hook git-pre-commit` — likely getStagedFiles() was empty when the hook ran (worktree/index timing on Windows).';
    case 'commit-succeeded-no-hook-signal':
      return 'Commit succeeded with normal git output only; no skip markers or secrets output — hook may not have run during commit, or Sonar scan no-op’d.';
    case 'pre-push-no-refs-fail-open':
      return 'Push succeeded and synthetic `sonar hook git-pre-push` with reconstructed stdin also exited 0 with no output — matches readGitPushRefs() returning [] (stdin empty/timeout), which skips scanning.';
    case 'last-commit-would-scan':
      return 'The commit already contains files, and an explicit `sonar hook git-pre-commit <files…>` post-mortem WOULD block — the failure is before/during hook invocation, not the analyzer.';
    case 'unknown':
      return 'Output did not match a known fail-open marker; inspect raw stdout/stderr below.';
  }
}

function probeDotGitKind(repoCwd: string): string {
  const dotGit = join(repoCwd, '.git');
  if (!existsSync(dotGit)) {
    return 'missing';
  }
  try {
    return lstatSync(dotGit).isFile()
      ? 'file (linked worktree admin pointer)'
      : 'directory (main worktree or bare checkout)';
  } catch (err) {
    return `present, kind unknown (${(err as Error).message})`;
  }
}

function probeRepoGitLayout(context: GitHookDiagnosticContext): string {
  const { repoCwd, hookEnv } = context;
  const worktreeList = gitSpawn(repoCwd, hookEnv, ['worktree', 'list', '--porcelain']);
  const status = gitSpawn(repoCwd, hookEnv, ['status', '--porcelain']);
  return [
    `  .git entry: ${probeDotGitKind(repoCwd)}`,
    `  rev-parse --show-toplevel: ${gitRevParse(repoCwd, hookEnv, '--show-toplevel')}`,
    `  rev-parse --git-dir: ${gitRevParse(repoCwd, hookEnv, '--git-dir')}`,
    `  rev-parse --git-common-dir: ${gitRevParse(repoCwd, hookEnv, '--git-common-dir')}`,
    `  worktree list (porcelain, exit ${worktreeList.exitCode ?? 'null'}):`,
    worktreeList.output || '  (empty)',
    `  status --porcelain (exit ${status.exitCode ?? 'null'}):`,
    status.output || '  (empty)',
  ].join('\n');
}

function resolveCommonDirLocalHook(
  repoCwd: string,
  env: Record<string, string>,
  hook: GitHookKind,
): string {
  const commonDir = gitRevParse(repoCwd, env, '--git-common-dir');
  if (commonDir.startsWith('(')) {
    return commonDir;
  }
  return join(commonDir, 'hooks', hook);
}

function probeStagedAndLastCommit(context: GitHookDiagnosticContext): {
  stagedFiles: string[];
  lastCommitFiles: string[];
  section: string;
} {
  const staged = gitSpawn(context.repoCwd, context.hookEnv, [
    'diff',
    '--cached',
    '--name-only',
    '--diff-filter=ACMR',
  ]);
  const stagedFiles =
    staged.exitCode === 0 && staged.output ? staged.output.split(/\r?\n/).filter(Boolean) : [];
  const lastCommit = gitSpawn(context.repoCwd, context.hookEnv, [
    'log',
    '-1',
    '--name-only',
    '--format=commit %H %s',
  ]);
  const lastCommitNames = gitSpawn(context.repoCwd, context.hookEnv, [
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    'HEAD',
  ]);
  const lastCommitFiles =
    lastCommitNames.exitCode === 0 && lastCommitNames.output
      ? lastCommitNames.output.split(/\r?\n/).filter(Boolean)
      : [];
  const parentDiff = gitSpawn(context.repoCwd, context.hookEnv, [
    'diff',
    '--name-only',
    'HEAD~1..HEAD',
  ]);
  const lines = [
    'post-mortem staged files (git diff --cached --name-only; empty after a successful commit is expected):',
    staged.output || '(empty)',
    '',
    'last commit summary (git log -1 --name-only):',
    lastCommit.output || '(empty)',
    '',
    'files in HEAD tree (git diff-tree --no-commit-id --name-only -r HEAD):',
    lastCommitNames.output || '(empty)',
    '',
    'files changed vs parent (git diff --name-only HEAD~1..HEAD):',
    parentDiff.output || '(empty)',
  ];
  return { stagedFiles, lastCommitFiles, section: lines.join('\n') };
}

function probeChainedHookMarker(repoCwd: string): string {
  const markerPath = join(repoCwd, CHAINED_HOOK_MARKER_FILE);
  if (!existsSync(markerPath)) {
    return `missing (${markerPath})`;
  }
  try {
    const content = readFileSync(markerPath, 'utf-8').trim();
    return content ? `present, content=${JSON.stringify(content)}` : 'present, empty';
  } catch (err) {
    return `present, read failed: ${(err as Error).message}`;
  }
}

function probeDirectSonarHookHandler(
  context: GitHookDiagnosticContext,
  sonarBinPath: string,
): { exitCode: number | null; output: string; section: string } {
  if (!existsSync(sonarBinPath)) {
    return {
      exitCode: null,
      output: '',
      section: `(skipped — sonar binary missing at ${sonarBinPath})`,
    };
  }
  const subcommand = sonarHookSubcommand(context.hook);
  const result = Bun.spawnSync([sonarBinPath, 'hook', subcommand], {
    cwd: context.repoCwd,
    env: context.hookEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = formatSpawnOutput(result);
  return {
    exitCode: result.exitCode,
    output: decodeSpawnOutput(result.stdout) + decodeSpawnOutput(result.stderr),
    section: [
      `sonar hook ${subcommand} post-mortem with empty stdin (cwd=${context.repoCwd}, exit=${result.exitCode ?? 'null'}):`,
      output,
    ].join('\n'),
  };
}

function probeExplicitFileScan(
  context: GitHookDiagnosticContext,
  sonarBinPath: string,
  files: string[],
): { exitCode: number | null; output: string; section: string } {
  if (files.length === 0) {
    return {
      exitCode: null,
      output: '',
      section: '(skipped — no files in HEAD to pass explicitly)',
    };
  }
  if (!existsSync(sonarBinPath)) {
    return {
      exitCode: null,
      output: '',
      section: `(skipped — sonar binary missing at ${sonarBinPath})`,
    };
  }
  const result = Bun.spawnSync([sonarBinPath, 'hook', 'git-pre-commit', ...files], {
    cwd: context.repoCwd,
    env: context.hookEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = formatSpawnOutput(result);
  return {
    exitCode: result.exitCode,
    output: decodeSpawnOutput(result.stdout) + decodeSpawnOutput(result.stderr),
    section: [
      `sonar hook git-pre-commit with explicit last-commit files [${files.join(', ')}] (exit=${result.exitCode ?? 'null'}):`,
      output,
    ].join('\n'),
  };
}

function buildSyntheticPrePushStdin(context: GitHookDiagnosticContext): {
  stdinLine: string;
  section: string;
} {
  const branch = gitSpawn(context.repoCwd, context.hookEnv, [
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ]);
  const head = gitRevParse(context.repoCwd, context.hookEnv, 'HEAD');
  const remoteRef = branch.output === 'HEAD' ? 'refs/heads/main' : `refs/heads/${branch.output}`;
  const localRef = remoteRef;
  let remoteSha = gitSpawn(context.repoCwd, context.hookEnv, [
    'rev-parse',
    `refs/remotes/origin/${branch.output === 'HEAD' ? 'main' : branch.output}`,
  ]);
  if (remoteSha.exitCode !== 0) {
    remoteSha = gitSpawn(context.repoCwd, context.hookEnv, ['rev-parse', 'origin/main']);
  }
  if (head.startsWith('(') || remoteSha.output.startsWith('(')) {
    return {
      stdinLine: '',
      section: 'synthetic pre-push stdin: (could not resolve HEAD and/or origin tip)',
    };
  }
  const zeros = remoteSha.exitCode !== 0 ? '0'.repeat(head.length) : remoteSha.output;
  const stdinLine = `${localRef} ${head} ${remoteRef} ${zeros}`;
  return {
    stdinLine,
    section: [
      'synthetic pre-push stdin (localRef localSha remoteRef remoteSha):',
      stdinLine,
      `  branch=${branch.output || '(empty)'}, head=${head}, remoteTip=${remoteSha.output || zeros}`,
    ].join('\n'),
  };
}

function probeSyntheticPrePushHook(
  context: GitHookDiagnosticContext,
  sonarBinPath: string,
): { exitCode: number | null; output: string; section: string } {
  if (context.hook !== 'pre-push') {
    return { exitCode: null, output: '', section: '(skipped — not a pre-push assertion)' };
  }
  if (!existsSync(sonarBinPath)) {
    return {
      exitCode: null,
      output: '',
      section: `(skipped — sonar binary missing at ${sonarBinPath})`,
    };
  }
  const { stdinLine, section: stdinSection } = buildSyntheticPrePushStdin(context);
  if (!stdinLine) {
    return { exitCode: null, output: '', section: stdinSection };
  }
  const env = {
    ...context.hookEnv,
    SONAR_PRE_PUSH_REMOTE_NAME: 'origin',
  };
  const result = Bun.spawnSync([sonarBinPath, 'hook', 'git-pre-push'], {
    cwd: context.repoCwd,
    env,
    stdin: stdinLine + '\n',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = formatSpawnOutput(result);
  return {
    exitCode: result.exitCode,
    output: decodeSpawnOutput(result.stdout) + decodeSpawnOutput(result.stderr),
    section: [stdinSection, '', `sonar hook git-pre-push with synthetic stdin (exit=${result.exitCode ?? 'null'}):`, output].join(
      '\n',
    ),
  };
}

function fileProbe(path: string): string {
  if (!existsSync(path)) {
    return 'missing';
  }
  try {
    if (IS_WINDOWS) {
      return 'present (exec bit not reported on Windows)';
    }
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
  const stdin =
    context.hook === 'pre-push' ? buildSyntheticPrePushStdin(context).stdinLine + '\n' : undefined;
  const result = Bun.spawnSync(['sh', hookScript], {
    cwd: context.repoCwd,
    env: context.hookEnv,
    stdin,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return [
    `direct ${context.hook} shell script invocation exit=${result.exitCode ?? 'null'}`,
    formatSpawnOutput(result),
  ].join('\n');
}

export function buildGitHookDiagnostics(
  context: GitHookDiagnosticContext,
  result: SpawnLike,
): string {
  const output = formatSpawnOutput(result);
  const combined = decodeSpawnOutput(result.stdout) + decodeSpawnOutput(result.stderr);
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
  const commonDirLocalHook = resolveCommonDirLocalHook(
    context.repoCwd,
    context.hookEnv,
    context.hook,
  );
  const { stagedFiles, lastCommitFiles, section: stagedSection } = probeStagedAndLastCommit(context);
  const directSonarHook = probeDirectSonarHookHandler(context, sonarBinPath);
  const explicitFileScan = probeExplicitFileScan(context, sonarBinPath, lastCommitFiles);
  const syntheticPrePush = probeSyntheticPrePushHook(context, sonarBinPath);
  const outcome = classifyHookOutput(combined, result.exitCode, {
    hook: context.hook,
    stagedFiles,
    directSonarHookOutput: directSonarHook.output,
    directSonarHookExit: directSonarHook.exitCode,
    lastCommitFiles,
    lastCommitExplicitScanOutput: explicitFileScan.output,
    lastCommitExplicitScanExit: explicitFileScan.exitCode,
    syntheticPrePushOutput: syntheticPrePush.output,
    syntheticPrePushExit: syntheticPrePush.exitCode,
  });

  const hookScriptHead = existsSync(globalHookScript)
    ? readFileSync(globalHookScript, 'utf-8').split('\n').slice(0, 16).join('\n')
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
    'repo / worktree layout:',
    probeRepoGitLayout(context),
    '',
    'files:',
    `  global hook script (${globalHookScript}): ${fileProbe(globalHookScript)}`,
    `  repo-local hook script (${localHookScript}): ${fileProbe(localHookScript)}`,
    `  common-dir local hook (${commonDirLocalHook}): ${commonDirLocalHook.startsWith('(') ? commonDirLocalHook : fileProbe(commonDirLocalHook)}`,
    `  sonar binary (${sonarBinPath}): ${fileProbe(sonarBinPath)}`,
    `  sonar-secrets in cli home (${secretsBinPath}): ${fileProbe(secretsBinPath)}`,
<<<<<<< HEAD
    `  chained hook marker (${CHAINED_HOOK_MARKER_FILE}): ${probeChainedHookMarker(context.repoCwd)}`,
    '',
    stagedSection,
=======
>>>>>>> b6416db6 (CLI-1219 Probe the versioned sonar-secrets binary path in hook diagnostics)
    '',
    'global hook script head:',
    hookScriptHead,
    '',
    'hook env (selected):',
    `  HOME=${context.hookEnv.HOME ?? context.hookEnv.USERPROFILE ?? '(unset)'}`,
    `  SONARQUBE_CLI_KEYCHAIN_FILE=${context.hookEnv.SONARQUBE_CLI_KEYCHAIN_FILE ?? '(unset)'}`,
    `  GIT_DIR=${context.hookEnv.GIT_DIR ?? '(unset)'}`,
    `  GIT_WORK_TREE=${context.hookEnv.GIT_WORK_TREE ?? '(unset)'}`,
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
    directSonarHook.section,
    '',
    explicitFileScan.section,
    '',
    syntheticPrePush.section,
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
