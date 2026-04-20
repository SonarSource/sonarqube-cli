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

// Real-network tests for install scripts — validates URL path structure on binaries.sonarsource.com

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

// PowerShell cold-start in afterEach needs more than the default 5s hook timeout
setDefaultTimeout(30_000);

const scriptDir = join(import.meta.dir, '../../user-scripts');
const isWindows = process.platform === 'win32';

describe.if(!isWindows)('install.sh (network)', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'sonar-install-test-'));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it(
    'downloads and installs sonar CLI binary on Unix',
    () => {
      const scriptPath = join(scriptDir, 'install.sh');

      const proc = Bun.spawnSync(['bash', scriptPath], {
        env: { HOME: tempHome, PATH: process.env.PATH! },
      });

      const installStderr = new TextDecoder().decode(proc.stderr);
      expect(proc.exitCode, `install.sh failed:\n${installStderr}`).toBe(0);

      const binaryPath = join(tempHome, '.local/share/sonarqube-cli/bin/sonar');
      expect(existsSync(binaryPath)).toBe(true);

      const helpProc = Bun.spawnSync([binaryPath, '--help'], {
        env: { HOME: tempHome, PATH: process.env.PATH! },
      });
      const helpOutput = new TextDecoder().decode(helpProc.stdout);
      expect(helpProc.exitCode).toBe(0);
      expect(helpOutput).toContain('sonar');
    },
    { timeout: 120_000 },
  );
});

function removeFromUserPath(dir: string) {
  const escaped = dir.replace(/'/g, "''");
  Bun.spawnSync([
    'powershell',
    '-NoProfile',
    '-Command',
    `$p = [Environment]::GetEnvironmentVariable('PATH','User'); if ($p) { $entries = ($p -split ';') | Where-Object { $_ -ne '${escaped}' }; [Environment]::SetEnvironmentVariable('PATH', ($entries -join ';'), 'User') }`,
  ]);
}

describe.if(isWindows)('install.ps1 (network)', () => {
  let tempLocalAppData: string;
  let installDir: string;

  beforeEach(() => {
    tempLocalAppData = mkdtempSync(join(tmpdir(), 'sonar-install-test-'));
    installDir = join(tempLocalAppData, 'sonarqube-cli', 'bin');
  });

  afterEach(() => {
    removeFromUserPath(installDir);
    rmSync(tempLocalAppData, { recursive: true, force: true });
  });

  it(
    'downloads and installs sonar CLI binary on Windows',
    () => {
      const scriptPath = join(scriptDir, 'install.ps1');

      const proc = Bun.spawnSync(
        ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        {
          env: { ...process.env, LOCALAPPDATA: tempLocalAppData },
        },
      );

      const installStderr = new TextDecoder().decode(proc.stderr);
      expect(proc.exitCode, `install.ps1 failed:\n${installStderr}`).toBe(0);

      const binaryPath = join(installDir, 'sonar.exe');
      expect(existsSync(binaryPath)).toBe(true);

      const helpProc = Bun.spawnSync([binaryPath, '--help'], {
        env: { ...process.env, LOCALAPPDATA: tempLocalAppData },
      });
      const helpOutput = new TextDecoder().decode(helpProc.stdout);
      expect(helpProc.exitCode).toBe(0);
      expect(helpOutput).toContain('sonar');
    },
    { timeout: 240_000 },
  );
});
