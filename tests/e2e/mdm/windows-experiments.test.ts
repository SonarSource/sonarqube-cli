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

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { getCliBinaryPath } from '../../integration/harness/cli-runner.js';
import { FakeBinariesServerBuilder } from '../../integration/harness/fake-binaries-server.js';
import { cliBytes } from '../../integration/specs/mdm/mdm-sandbox';
import {
  CAN_RUN_SYSTEM_E2E,
  forceRemove,
  IS_WINDOWS,
  isolatedEnv,
  makeIsolatedHome,
  POWERSHELL,
  removeSystemInstall,
  runBootstrapElevated,
  SYSTEM_BINARY,
} from './_helpers';

setDefaultTimeout(240_000);

const PING = join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'PING.EXE');
const scratch = IS_WINDOWS ? mkdtempSync(join(tmpdir(), 'sonar-exp-')) : '';

interface PsResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

function report(name: string, data: Record<string, unknown>): void {
  console.log(`EXP ${name} ${JSON.stringify(data)}`);
}

async function ps(script: string, env: Record<string, string> = {}): Promise<PsResult> {
  const startedAt = Date.now();
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const proc = Bun.spawn(
    [POWERSHELL, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    elapsedMs: Date.now() - startedAt,
  };
}

function bootstrapEnv(home: string, withPathext: boolean): Record<string, string> {
  const env = isolatedEnv(home);
  if (!withPathext) {
    delete env.PATHEXT;
  }
  return env;
}

function attempt(action: () => void): string {
  try {
    action();
    return 'ok';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? String(error);
  }
}

const JOB_INFO_SCRIPT = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class J {
  [DllImport("kernel32.dll")] public static extern bool IsProcessInJob(IntPtr p, IntPtr job, out bool r);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] public static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, int len, out int ret);
}
'@
$r = $false
[J]::IsProcessInJob([J]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$r) | Out-Null
$flags = 'n/a'
if ($r) {
  $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)
  $ret = 0
  if ([J]::QueryInformationJobObject([IntPtr]::Zero, 9, $buf, 144, [ref]$ret)) {
    $flags = '0x{0:x}' -f [Runtime.InteropServices.Marshal]::ReadInt32($buf, 16)
  }
}
"inJob=$r limitFlags=$flags psVersion=$($PSVersionTable.PSVersion) os=$([Environment]::OSVersion.Version) user=$([Environment]::UserName)"
`;

const POSIX_DELETE_SCRIPT = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class D {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateFileW(string n, uint a, uint s, IntPtr sec, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetFileInformationByHandle(IntPtr h, int c, ref uint info, int len);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
$h = [D]::CreateFileW($env:EXP_TARGET, 0x10000, 7, [IntPtr]::Zero, 3, 0x80, [IntPtr]::Zero)
if ($h -eq [IntPtr](-1)) { "open failed win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 0 }
$flags = [uint32]0x13
$ok = [D]::SetFileInformationByHandle($h, 21, [ref]$flags, 4)
$err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
[D]::CloseHandle($h) | Out-Null
"posixDelete ok=$ok win32=$err existsAfter=$(Test-Path -LiteralPath $env:EXP_TARGET)"
`;

const MOVE_ON_REBOOT_SCRIPT = String.raw`
Add-Type -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool MoveFileEx(string a, string b, int f);' -Name 'M' -Namespace 'N'
$ok = [N.M]::MoveFileEx($env:EXP_TARGET, [NullString]::Value, 4)
"moveFileEx ok=$ok win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
`;

function helperScript(target: string, log: string): string {
  return String.raw`
$log = '${log}'
$target = '${target}'
Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) started pid=$PID"
$deadline = (Get-Date).AddSeconds(40)
while ((Test-Path -LiteralPath $target) -and (Get-Date) -lt $deadline) {
  try { Remove-Item -LiteralPath $target -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 300 }
}
Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) done existsAfter=$(Test-Path -LiteralPath $target)"
`;
}

function parentScript(method: string, victim: string, helperEncoded: string): string {
  const powershell = POWERSHELL;
  const launchers: Record<string, string> = {
    startProcess: `Start-Process -FilePath '${powershell}' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${helperEncoded}' -WindowStyle Hidden`,
    dotnetProcess: `$psi = New-Object System.Diagnostics.ProcessStartInfo; $psi.FileName = '${powershell}'; $psi.Arguments = '-NoProfile -NonInteractive -EncodedCommand ${helperEncoded}'; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; [System.Diagnostics.Process]::Start($psi) | Out-Null`,
    cmdStart: `cmd.exe /c start "" /b "${powershell}" -NoProfile -NonInteractive -EncodedCommand ${helperEncoded}`,
    cimCreate: `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '"${powershell}" -NoProfile -NonInteractive -EncodedCommand ${helperEncoded}' } | Out-Null`,
  };
  return `
Start-Process -FilePath '${victim}' -ArgumentList '-n','6','127.0.0.1' -WindowStyle Hidden
${launchers[method]}
`;
}

describe.skipIf(!IS_WINDOWS || !CAN_RUN_SYSTEM_E2E)('windows self-replace experiments', () => {
  afterAll(() => {
    forceRemove(scratch);
    removeSystemInstall();
  });

  it('describes the process environment', async () => {
    const result = await ps(JOB_INFO_SCRIPT);
    report('environment', { exit: result.exitCode, out: result.stdout, err: result.stderr });
    expect(result.exitCode).toBe(0);
  });

  it('shows what Windows allows on a running executable', async () => {
    const dir = join(scratch, 'locked');
    mkdirSync(dir, { recursive: true });
    const direct = join(dir, 'direct.exe');
    const renamed = join(dir, 'renamed.exe');
    const renamedAside = join(dir, 'renamed.exe.old');
    copyFileSync(PING, direct);
    copyFileSync(PING, renamed);
    const first = Bun.spawn([direct, '-n', '30', '127.0.0.1'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const second = Bun.spawn([renamed, '-n', '30', '127.0.0.1'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await Bun.sleep(1000);

    const deleteRunning = attempt(() => rmSync(direct));
    const renameRunning = attempt(() => renameSync(renamed, renamedAside));
    const deleteRenamedRunning = attempt(() => rmSync(renamedAside));
    const posixOnRunning = await ps(POSIX_DELETE_SCRIPT, { EXP_TARGET: direct });
    const posixOnRenamed = await ps(POSIX_DELETE_SCRIPT, { EXP_TARGET: renamedAside });
    const overwriteRunning = attempt(() => copyFileSync(PING, direct));
    const reboot = await ps(MOVE_ON_REBOOT_SCRIPT, { EXP_TARGET: renamedAside });

    first.kill();
    second.kill();
    await Promise.all([first.exited, second.exited]);
    const afterExit = {
      directExists: existsSync(direct),
      asideExists: existsSync(renamedAside),
      deleteDirect: attempt(() => rmSync(direct, { force: true })),
      deleteAside: attempt(() => rmSync(renamedAside, { force: true })),
    };
    report('locked-file', {
      deleteRunning,
      renameRunning,
      deleteRenamedRunning,
      overwriteRunning,
      posixOnRunning: posixOnRunning.stdout || posixOnRunning.stderr,
      posixOnRenamed: posixOnRenamed.stdout || posixOnRenamed.stderr,
      reboot: reboot.stdout || reboot.stderr,
      afterExit,
    });
    expect(true).toBe(true);
  });

  for (const method of ['startProcess', 'dotnetProcess', 'cmdStart', 'cimCreate']) {
    it(`deletes a busy file from a helper launched by ${method} after the parent exits`, async () => {
      const dir = join(scratch, `helper-${method}`);
      mkdirSync(dir, { recursive: true });
      const victim = join(dir, 'victim.exe');
      const log = join(dir, 'helper.log');
      copyFileSync(PING, victim);
      const helperEncoded = Buffer.from(helperScript(victim, log), 'utf16le').toString('base64');

      const parent = await ps(parentScript(method, victim, helperEncoded));
      const startedAt = Date.now();
      while (existsSync(victim) && Date.now() - startedAt < 30_000) {
        await Bun.sleep(250);
      }
      const logText = existsSync(log) ? await Bun.file(log).text() : '<no helper log>';
      report(`helper-${method}`, {
        parentExit: parent.exitCode,
        parentMs: parent.elapsedMs,
        parentErr: parent.stderr,
        victimExistsAfterWait: existsSync(victim),
        waitedMs: Date.now() - startedAt,
        helperLog: logText.trim().split(/\r?\n/),
      });
      expect(true).toBe(true);
    });
  }

  for (const [pathext, round] of [
    ['without PATHEXT', 1],
    ['without PATHEXT', 2],
    ['with PATHEXT', 1],
    ['with PATHEXT', 2],
  ] as const) {
    it(`bootstrap script ${pathext} round ${String(round)}: timeline of runner and installed binary`, async () => {
      removeSystemInstall();
      const home = makeIsolatedHome();
      const cdn = await new FakeBinariesServerBuilder().withStableVersion('9.9.9').start();
      cdn.publishCliArtifact('9.9.9', cliBytes());
      const startedAt = Date.now();
      const appearedAt: { value: number | null } = { value: null };
      const watcher = (async () => {
        while (appearedAt.value === null && Date.now() - startedAt < 120_000) {
          if (existsSync(SYSTEM_BINARY)) {
            appearedAt.value = Date.now() - startedAt;
          }
          await Bun.sleep(25);
        }
      })();

      const result = await runBootstrapElevated(
        'install-bootstrap.ps1',
        { baseUrl: cdn.cliArtifactBaseUrl() },
        bootstrapEnv(home, pathext === 'with PATHEXT'),
      );
      const returnedAfterMs = Date.now() - startedAt;
      const snapshot = await ps(
        'Get-Process | Where-Object { $_.Name -like \'sonar*\' } | ForEach-Object { "$($_.Name) pid=$($_.Id)" }',
      );
      const existsAtReturn = existsSync(SYSTEM_BINARY);
      await Bun.sleep(5000);
      await watcher;
      report(`bootstrap-${pathext.replaceAll(' ', '-')}-${String(round)}`, {
        exit: result.exitCode,
        returnedAfterMs,
        binaryAppearedAfterMs: appearedAt.value,
        existsAtReturn,
        sonarProcessesAtReturn: snapshot.stdout.split(/\r?\n/).filter(Boolean),
        stdout: result.stdout.trim().split(/\r?\n/),
        stderr: result.stderr.trim(),
      });
      await cdn.stop();
      forceRemove(home);
      removeSystemInstall();
      expect(true).toBe(true);
    });
  }

  for (const variant of ['bunSpawn', 'powershellCall', 'powershellStartProcessWait']) {
    it(`runner variant ${variant}: how long until mdm install is complete`, async () => {
      removeSystemInstall();
      const home = makeIsolatedHome();
      const runner = join(scratch, `runner-${variant}.exe`);
      copyFileSync(getCliBinaryPath(), runner);
      const startedAt = Date.now();
      let returnedAfterMs = 0;
      let detail: Record<string, unknown> = {};
      if (variant === 'bunSpawn') {
        const proc = Bun.spawn([runner, 'mdm', 'install'], {
          env: isolatedEnv(home),
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        returnedAfterMs = Date.now() - startedAt;
        detail = { exitCode, stdout: stdout.trim().split(/\r?\n/), stderr: stderr.trim() };
      } else {
        const script =
          variant === 'powershellCall'
            ? `& '${runner}' mdm install\nexit $LASTEXITCODE`
            : `$p = Start-Process -FilePath '${runner}' -ArgumentList 'mdm','install' -Wait -PassThru -NoNewWindow\nexit $p.ExitCode`;
        const result = await ps(script, isolatedEnv(home));
        returnedAfterMs = Date.now() - startedAt;
        detail = {
          exitCode: result.exitCode,
          stdout: result.stdout.split(/\r?\n/),
          stderr: result.stderr,
        };
      }
      const existsAtReturn = existsSync(SYSTEM_BINARY);
      const waitStartedAt = Date.now();
      while (!existsSync(SYSTEM_BINARY) && Date.now() - waitStartedAt < 30_000) {
        await Bun.sleep(25);
      }
      report(`runner-${variant}`, {
        returnedAfterMs,
        existsAtReturn,
        appearedLaterAfterMs: existsAtReturn ? 0 : Date.now() - waitStartedAt,
        existsEventually: existsSync(SYSTEM_BINARY),
        ...detail,
      });
      forceRemove(home);
      removeSystemInstall();
      expect(true).toBe(true);
    });
  }
});
