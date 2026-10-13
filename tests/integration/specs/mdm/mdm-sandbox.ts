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

import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';

import { standaloneBinaryPath } from '@/commands/mdm/mdm-environment.ts';
import { ENV_MDM_BINARY_PATH, ENV_MDM_USER_HOMES } from '@/core/config-constants.ts';

import type { TestHarness } from '../../harness';
import { IS_WINDOWS } from '../../harness';
import { getCliBinaryPath } from '../../harness/cli-runner.js';
import type { Dir } from '../../harness/dir';
import type { FakeBinariesServer } from '../../harness/fake-binaries-server.js';
import type { CliResult } from '../../harness/types.js';

export const SKIP_ON_WINDOWS = IS_WINDOWS;
export const SKIP_ON_UNIX = !IS_WINDOWS;

const RESOURCES_DIR = join(import.meta.dir, '..', '..', 'resources');
const EXECUTABLE_SUFFIX = IS_WINDOWS ? '.exe' : '';
const BOOTSTRAP_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'mdm-scripts',
  'direct-sonar-cdn',
);
const SYSTEM_ROOT = process.env.SystemRoot ?? String.raw`C:\Windows`;
const WINDOWS_SYSTEM_PATH = [
  join(SYSTEM_ROOT, 'System32'),
  join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0'),
].join(delimiter);
const UNIX_SYSTEM_PATH = ['/usr/bin', '/bin'].join(delimiter);
const PENDING_RENAMES_SCRIPT = String.raw`(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue).PendingFileRenameOperations`;

export const STUB_VERSIONS = ['1.0.0', '2.0.0', '3.0.0'] as const;
export const NOT_AN_EXECUTABLE = Buffer.from('this is not an executable');
export const MISMATCHED_CHECKSUM = 'f'.repeat(64);

const referenceDigests = new Map<string, string>();

function digestOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function referenceDigest(path: string): string {
  const cached = referenceDigests.get(path);
  if (cached) {
    return cached;
  }
  const digest = digestOf(path);
  referenceDigests.set(path, digest);
  return digest;
}

export function stubPath(version: string): string {
  return join(RESOURCES_DIR, 'mdm-stubs', `cli-stub-${version}${EXECUTABLE_SUFFIX}`);
}

export function stubBytes(version: string): Buffer {
  return readFileSync(stubPath(version));
}

export function cliBytes(): Buffer {
  return readFileSync(getCliBinaryPath());
}

export function isStub(path: string, version: string): boolean {
  return existsSync(path) && digestOf(path) === referenceDigest(stubPath(version));
}

export function isRealCli(path: string): boolean {
  return existsSync(path) && digestOf(path) === referenceDigest(getCliBinaryPath());
}

export function isSymlink(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}

export function modeOf(path: string): number {
  return lstatSync(path).mode & 0o777;
}

export function isRoot(): boolean {
  return process.getuid?.() === 0;
}

export function isScheduledForRebootDelete(path: string): boolean {
  if (!IS_WINDOWS) {
    return false;
  }
  const result = Bun.spawnSync([
    join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    PENDING_RENAMES_SCRIPT,
  ]);
  return result.stdout.toString().toLowerCase().includes(path.toLowerCase());
}

export interface BootstrapOptions {
  approvedVersion?: string;
  baseUrl: string;
}

export class MdmSandbox {
  readonly root: Dir;
  readonly binaryPath: string;
  readonly homes: string[];
  readonly pathDir: string;
  readonly tempDir: string;

  constructor(private readonly harness: TestHarness) {
    this.root = harness.cwd.dir('mdm');
    this.binaryPath = this.root.file('system', 'bin', `sonar${EXECUTABLE_SUFFIX}`).path;
    this.homes = [this.root.dir('home-a').path, this.root.dir('home-b').path];
    this.pathDir = this.root.dir('path-bin').path;
    this.tempDir = this.root.dir('tmp').path;
    mkdirSync(this.pathDir, { recursive: true });
    mkdirSync(this.tempDir, { recursive: true });
  }

  env(): Record<string, string> {
    const systemPath = IS_WINDOWS ? WINDOWS_SYSTEM_PATH : UNIX_SYSTEM_PATH;
    return {
      [ENV_MDM_BINARY_PATH]: this.binaryPath,
      [ENV_MDM_USER_HOMES]: this.homes.join(delimiter),
      PATH: [this.pathDir, systemPath].join(delimiter),
      ...(IS_WINDOWS
        ? { PATHEXT: '.EXE', TEMP: this.tempDir, TMP: this.tempDir }
        : { TMPDIR: this.tempDir }),
    };
  }

  run(args: string, options: { binaryPath?: string; extraEnv?: Record<string, string> } = {}) {
    return this.harness.run(`mdm ${args}`, {
      binaryPath: options.binaryPath,
      extraEnv: { ...this.env(), ...options.extraEnv },
    });
  }

  runWithCdn(args: string, cdn: FakeBinariesServer, options: { binaryPath?: string } = {}) {
    return this.run(`${args} --artifact-base-url ${cdn.cliArtifactBaseUrl()}`, options);
  }

  standalonePath(homeIndex: number): string {
    return standaloneBinaryPath(this.homes[homeIndex]);
  }

  seedStandalone(homeIndex: number): string {
    const path = this.standalonePath(homeIndex);
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(stubPath('1.0.0'), path);
    return path;
  }

  seedStandaloneSymlink(homeIndex: number, target = this.binaryPath): string {
    const path = this.standalonePath(homeIndex);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
    return path;
  }

  seedSystemBinary(version: string, mode = 0o755): void {
    mkdirSync(dirname(this.binaryPath), { recursive: true });
    copyFileSync(stubPath(version), this.binaryPath);
    if (!IS_WINDOWS) {
      chmodSync(this.binaryPath, mode);
    }
  }

  seedPathCopy(source: string, directory = this.pathDir): string {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `sonar${EXECUTABLE_SUFFIX}`);
    copyFileSync(source, path);
    if (!IS_WINDOWS) {
      chmodSync(path, 0o755);
    }
    return path;
  }

  seedFile(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  extraEntriesNextToBinary(): string[] {
    if (!existsSync(dirname(this.binaryPath))) {
      return [];
    }
    return readdirSync(dirname(this.binaryPath)).filter(
      (name) => name !== basename(this.binaryPath),
    );
  }

  unscheduledEntriesNextToBinary(): string[] {
    return this.extraEntriesNextToBinary().filter(
      (name) =>
        !name.endsWith('.old') || !isScheduledForRebootDelete(join(dirname(this.binaryPath), name)),
    );
  }

  leftoverDownloads(): string[] {
    return readdirSync(this.tempDir).filter((name) => name.startsWith('sonar-mdm-'));
  }

  async runBootstrap(options: BootstrapOptions): Promise<CliResult> {
    const script = IS_WINDOWS ? 'install-bootstrap.ps1' : 'install-bootstrap.sh';
    const renderedPath = this.root.file(`rendered-${script}`).path;
    this.seedFile(renderedPath, renderBootstrap(script, options));
    const command = IS_WINDOWS
      ? [
          join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          renderedPath,
        ]
      : ['bash', renderedPath];
    const startedAt = Date.now();
    const proc = Bun.spawn(command, {
      env: this.harness.env({ extraEnv: this.env() }),
      cwd: this.harness.cwd.path,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, durationMs: Date.now() - startedAt };
  }
}

export function renderBootstrap(
  script: string,
  { approvedVersion, baseUrl }: BootstrapOptions,
): string {
  const quote = (value: string) => (script.endsWith('.ps1') ? `'${value}'` : `"${value}"`);
  let content = readFileSync(join(BOOTSTRAP_DIR, script), 'utf8');
  content = content.replace('{{SONARQUBE_CLI_ARTIFACT_BASE_URL}}', quote(baseUrl));
  if (approvedVersion !== undefined) {
    content = content.replace('{{SONARQUBE_CLI_APPROVED_VERSION}}', quote(approvedVersion));
  }
  return content;
}
