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

// Dispose diagnostics for Windows afterEach hangs. Quiet when teardown is fast.
// Deletes the temp tree file-by-file so a blocked unlink names the path. When rm
// blocks, dump Sysinternals handle.exe holders for .exe files in the temp dir.

import { existsSync } from 'node:fs';
import { readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IS_WINDOWS } from './platform';

const WATCHDOG_MS = 1_000;
const HOLDERS_TIMEOUT_MS = 1_500;
const HANDLE_DOWNLOAD_MS = 5_000;
const HANDLE_RUN_MS = 4_000;
const HANDLE_OUTPUT_CAP = 4_000;
const SLOW_UNLINK_MS = 100;
const EXE_LOG_CAP = 8;
const HANDLE64_URL = 'https://live.sysinternals.com/handle64.exe';
const HANDLE64_PATH = join(tmpdir(), 'sqcli-handle64.exe');

export function startDisposeTrace(tempDir: string): DisposeTrace {
  return new DisposeTrace(tempDir);
}

export class DisposeTrace {
  private readonly startedAt = Date.now();
  private currentPhase = 'start';
  private readonly watchdog: ReturnType<typeof setInterval>;
  private exePaths: string[] = [];
  private lockDumpStarted = false;
  private phaseChangedAt = Date.now();

  constructor(private readonly tempDir: string) {
    this.watchdog = setInterval(() => {
      if (Date.now() - this.phaseChangedAt < WATCHDOG_MS) {
        return;
      }
      this.log(`still in ${this.currentPhase} after ${this.elapsed()}ms`);
      if (IS_WINDOWS && this.currentPhase.startsWith('rm')) {
        void this.ensureLockersDumped();
      }
    }, WATCHDOG_MS);
    this.watchdog.unref();
  }

  noteExePaths(paths: string[]): void {
    this.exePaths = paths;
  }

  noteRmTarget(kind: string, entry: string): void {
    this.currentPhase = `rm ${kind} ${entry}`;
    this.phaseChangedAt = Date.now();
  }

  async phase<T>(name: string, work: () => Promise<T>): Promise<T> {
    this.currentPhase = name;
    this.phaseChangedAt = Date.now();
    const phaseStarted = Date.now();
    try {
      return await work();
    } finally {
      const ms = Date.now() - phaseStarted;
      if (ms >= WATCHDOG_MS) {
        this.log(`phase ${name} finished in ${ms}ms`);
      }
    }
  }

  stop(): void {
    clearInterval(this.watchdog);
  }

  log(message: string): void {
    process.stderr.write(
      `[harness.dispose +${this.elapsed()}ms] ${message} path=${this.tempDir}\n`,
    );
  }

  swallow(label: string): (err: unknown) => undefined {
    return (err) => {
      this.log(`swallowed ${label}: ${formatError(err)}`);
      return undefined;
    };
  }

  async ensureLockersDumped(): Promise<void> {
    if (this.lockDumpStarted) {
      return;
    }
    this.lockDumpStarted = true;
    await this.dumpLockers();
  }

  private async dumpLockers(): Promise<void> {
    const exes = this.exePaths.slice(0, EXE_LOG_CAP).join(' | ') || '<none>';
    this.log(`exes: ${exes}`);
    this.log(`handles: ${await windowsHandleDump(this.tempDir, this.exePaths)}`);
    this.log(`holders: ${await windowsHolders(this.tempDir)}`);
    this.log(`scanners: ${await windowsScannerProcesses()}`);
  }

  private elapsed(): number {
    return Date.now() - this.startedAt;
  }
}

export async function rmTempDirTraced(trace: DisposeTrace, tempDir: string): Promise<void> {
  if (IS_WINDOWS) {
    trace.noteExePaths(await listExePaths(tempDir));
  }

  const { files, dirs } = await collectTree(tempDir);
  for (const file of files) {
    await removeTraced(trace, 'file', file);
  }
  for (const dir of dirs) {
    await removeTraced(trace, 'dir', dir);
  }
}

async function collectTree(root: string): Promise<{ files: string[]; dirs: string[] }> {
  const files: string[] = [];
  const dirs: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        dirs.push(full);
        await walk(full);
      } else {
        files.push(full);
      }
    }
  }

  await walk(root);
  dirs.push(root);
  dirs.sort((left, right) => right.length - left.length);
  return { files, dirs };
}

async function removeTraced(
  trace: DisposeTrace,
  kind: 'file' | 'dir',
  entry: string,
): Promise<void> {
  trace.noteRmTarget(kind, entry);
  const started = Date.now();
  try {
    if (kind === 'file') {
      await unlink(entry);
    } else {
      await rmdir(entry);
    }
  } catch (err) {
    trace.log(`unlink ${kind} fail ${Date.now() - started}ms ${formatError(err)} entry=${entry}`);
    if (IS_WINDOWS) {
      await trace.ensureLockersDumped();
    }
    return;
  }
  const ms = Date.now() - started;
  if (ms >= SLOW_UNLINK_MS) {
    trace.log(`unlink ${kind} slow ${ms}ms entry=${entry}`);
  }
}

function formatError(err: unknown): string {
  if (err && typeof err === 'object') {
    const { code, message, path } = err as { code?: string; message?: string; path?: string };
    return `code=${code ?? '?'} path=${path ?? '?'} ${message ?? ''}`;
  }
  return String(err);
}

async function listExePaths(root: string): Promise<string[]> {
  try {
    const names = await readdir(root, { recursive: true });
    return names
      .filter((name) => name.toLowerCase().endsWith('.exe'))
      .map((name) => join(root, name));
  } catch {
    return [];
  }
}

async function windowsHandleDump(tempDir: string, exePaths: string[]): Promise<string> {
  const handlePath = await ensureHandle64();
  if (handlePath === null) {
    return '<handle64 unavailable>';
  }
  const targets = exePaths.length > 0 && exePaths.length <= EXE_LOG_CAP ? exePaths : [tempDir];
  const chunks: string[] = [];
  for (const target of targets) {
    chunks.push(await runHandle64(handlePath, target));
  }
  return clip(chunks.join(' || '));
}

async function ensureHandle64(): Promise<string | null> {
  const runnerTemp = process.env.RUNNER_TEMP;
  const candidates = [
    runnerTemp === undefined ? undefined : join(runnerTemp, 'handle64.exe'),
    HANDLE64_PATH,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(candidate)) {
      return candidate;
    }
  }
  try {
    const response = await fetch(HANDLE64_URL, { signal: AbortSignal.timeout(HANDLE_DOWNLOAD_MS) });
    if (!response.ok) {
      return null;
    }
    await Bun.write(HANDLE64_PATH, await response.arrayBuffer());
    return HANDLE64_PATH;
  } catch {
    return null;
  }
}

async function runHandle64(handlePath: string, target: string): Promise<string> {
  try {
    const proc = Bun.spawn([handlePath, '-accepteula', '-nobanner', target], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = setTimeout(() => proc.kill(), HANDLE_RUN_MS);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const body = stdout.trim() || stderr.trim();
      if (body.length > 0) {
        return `${target} => ${body.replaceAll('\n', ' | ')}`;
      }
      return `${target} => <empty exit=${exitCode}>`;
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    return `<handle64 failed: ${err instanceof Error ? err.message : String(err)}>`;
  }
}

async function windowsHolders(tempDir: string): Promise<string> {
  return runPowerShell(
    [
      'Get-CimInstance Win32_Process |',
      'Where-Object {',
      '  ($_.ExecutablePath -and $_.ExecutablePath.Contains($env:HARNESS_TEMP)) -or',
      '  ($_.CommandLine -and $_.CommandLine.Contains($env:HARNESS_TEMP))',
      '} |',
      'ForEach-Object { "{0} {1} exe={2} cmd={3}" -f $_.ProcessId, $_.Name, $_.ExecutablePath, $_.CommandLine }',
    ].join(' '),
    { HARNESS_TEMP: tempDir },
    '<none with ExecutablePath/CommandLine in temp dir>',
  );
}

async function windowsScannerProcesses(): Promise<string> {
  return runPowerShell(
    [
      'Get-Process MsMpEng,WinDefend,SearchIndexer,MsSense,cag-stub,sonar-secrets,sonar-context-augmentation -ErrorAction SilentlyContinue |',
      'ForEach-Object { "{0} pid={1}" -f $_.Name, $_.Id }',
    ].join(' '),
    {},
    '<none of MsMpEng/WinDefend/SearchIndexer/MsSense/cag-stub/sonar-secrets>',
  );
}

async function runPowerShell(
  command: string,
  extraEnv: Record<string, string>,
  emptyMessage: string,
): Promise<string> {
  try {
    const proc = Bun.spawn(['powershell', '-NoProfile', '-Command', command], {
      env: { ...process.env, ...extraEnv },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = setTimeout(() => proc.kill(), HOLDERS_TIMEOUT_MS);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const body = stdout.trim();
      if (body.length > 0) {
        return clip(body.replaceAll('\n', ' || '));
      }
      if (exitCode !== 0) {
        return `<empty exit=${exitCode} stderr=${stderr.trim() || 'none'}>`;
      }
      return emptyMessage;
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    return `<powershell failed: ${err instanceof Error ? err.message : String(err)}>`;
  }
}

function clip(text: string): string {
  if (text.length <= HANDLE_OUTPUT_CAP) {
    return text;
  }
  return `${text.slice(0, HANDLE_OUTPUT_CAP)}…`;
}
