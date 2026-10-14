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

// `sonar mdm` end-to-end helpers. These suites write to the real system locations
// (/usr/local/bin/sonar, C:\Program Files\sonarqube-cli\bin, the machine PATH), so they run only
// on CI (or with SONARQUBE_CLI_E2E_MDM=1), only when elevated, and never over an existing install.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { ISOLATED_CLI_SPAWN_ENV } from '../../_common/isolated-cli-env.js';
import { getCliBinaryPath } from '../../integration/harness/cli-runner.js';
import { renderBootstrap } from '../../integration/specs/mdm/mdm-sandbox';

export const IS_WINDOWS = process.platform === 'win32';
export const SYSTEM_BINARY = IS_WINDOWS
  ? String.raw`C:\Program Files\sonarqube-cli\bin\sonar.exe`
  : '/usr/local/bin/sonar';
export const REAL_CDN_BASE_URL = 'https://binaries.sonarsource.com/Distribution/sonarqube-cli';

const SYSTEM_ROOT = process.env.SystemRoot ?? String.raw`C:\Windows`;
export const POWERSHELL = join(
  SYSTEM_ROOT,
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const SYSTEM_PATH = IS_WINDOWS
  ? [join(SYSTEM_ROOT, 'System32'), dirname(POWERSHELL)].join(delimiter)
  : ['/usr/bin', '/bin'].join(delimiter);

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function isElevated(): boolean {
  if (IS_WINDOWS) {
    const probe = Bun.spawnSync([
      POWERSHELL,
      '-NoProfile',
      '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ]);
    return probe.stdout.toString().trim() === 'True';
  }
  return process.getuid?.() === 0 || Bun.spawnSync(['sudo', '-n', 'true']).exitCode === 0;
}

function resolveSkipReason(): string | null {
  if (process.env.CI !== 'true' && process.env.SONARQUBE_CLI_E2E_MDM !== '1') {
    return 'not running on CI (set SONARQUBE_CLI_E2E_MDM=1 to opt in on a disposable machine)';
  }
  if (!isElevated()) {
    return 'needs root (or passwordless sudo) / an elevated Windows session';
  }
  if (existsSync(SYSTEM_BINARY)) {
    return `refusing to run over the existing install at ${SYSTEM_BINARY}`;
  }
  return null;
}

export const SKIP_REASON = resolveSkipReason();
export const CAN_RUN_SYSTEM_E2E = SKIP_REASON === null;

if (!CAN_RUN_SYSTEM_E2E) {
  console.warn(`sonar mdm system e2e skipped: ${SKIP_REASON}`);
}

export function isolatedEnv(
  home: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...(IS_WINDOWS ? { SystemRoot: SYSTEM_ROOT, USERPROFILE: home } : {}),
    HOME: home,
    PATH: SYSTEM_PATH,
    ...ISOLATED_CLI_SPAWN_ENV,
    ...extra,
  };
}

async function collect(proc: ReturnType<typeof Bun.spawn>): Promise<RunResult> {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export function runElevatedCommand(
  command: string[],
  env: Record<string, string>,
): Promise<RunResult> {
  const useSudo = !IS_WINDOWS && process.getuid?.() !== 0;
  const assignments = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  const spawnArgs = useSudo ? ['sudo', '-n', 'env', ...assignments, ...command] : command;
  return collect(
    Bun.spawn(spawnArgs, {
      env: useSudo ? { PATH: SYSTEM_PATH } : env,
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
}

export function runMdm(
  args: string[],
  env: Record<string, string>,
  binary = getCliBinaryPath(),
): Promise<RunResult> {
  return runElevatedCommand([binary, 'mdm', ...args], env);
}

export async function runUnelevated(
  binary: string,
  args: string[],
  home: string,
): Promise<RunResult> {
  return collect(
    Bun.spawn([binary, ...args], { env: isolatedEnv(home), stdout: 'pipe', stderr: 'pipe' }),
  );
}

export async function runBootstrapElevated(
  scriptName: 'install-bootstrap.sh' | 'install-bootstrap.ps1',
  options: { baseUrl: string; approvedVersion?: string },
  env: Record<string, string>,
): Promise<RunResult> {
  const workDir = mkdtempSync(join(tmpdir(), 'sonar-mdm-e2e-'));
  const scriptPath = join(workDir, scriptName);
  await Bun.write(scriptPath, renderBootstrap(scriptName, options));
  const command =
    scriptName === 'install-bootstrap.ps1'
      ? [
          POWERSHELL,
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
        ]
      : ['bash', scriptPath];
  try {
    return await runElevatedCommand(command, env);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function makeIsolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'sonar-mdm-e2e-home-'));
  mkdirSync(join(home, '.sonar'), { recursive: true });
  return home;
}

export function forceRemove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    if (!IS_WINDOWS) {
      Bun.spawnSync(['sudo', '-n', 'rm', '-rf', path]);
    }
  }
}

export function removeSystemInstall(): void {
  if (IS_WINDOWS) {
    forceRemove(dirname(dirname(SYSTEM_BINARY)));
    return;
  }
  forceRemove(SYSTEM_BINARY);
  forceRemove(`${SYSTEM_BINARY}.new`);
}

export function realUserHomeIfEnumerable(): string | null {
  const home = homedir();
  if (IS_WINDOWS) {
    return home
      .toLowerCase()
      .startsWith(join(process.env.SystemDrive ?? 'C:', 'Users').toLowerCase())
      ? home
      : null;
  }
  const prefix = process.platform === 'darwin' ? '/Users/' : '/home/';
  return home.startsWith(prefix) ? home : null;
}

export function machinePath(): string {
  const result = Bun.spawnSync([
    POWERSHELL,
    '-NoProfile',
    '-Command',
    "[Environment]::GetEnvironmentVariable('Path','Machine')",
  ]);
  return result.stdout.toString().trim();
}

export function restoreMachinePath(original: string): void {
  Bun.spawnSync(
    [
      POWERSHELL,
      '-NoProfile',
      '-Command',
      "[Environment]::SetEnvironmentVariable('Path', $env:SONAR_MDM_ORIGINAL_PATH, 'Machine')",
    ],
    { env: { SystemRoot: SYSTEM_ROOT, SONAR_MDM_ORIGINAL_PATH: original } },
  );
}

export function directoryEntries(path: string): string[] {
  return existsSync(path) ? readdirSync(path) : [];
}
