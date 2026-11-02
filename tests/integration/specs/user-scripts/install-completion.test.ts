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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

const isWindows = process.platform === 'win32';

for (const variant of ['install', 'install-prerelease']) {
  describe.if(!isWindows)(`${variant}.sh completion`, () => {
    const script = readFileSync(
      join(import.meta.dir, `../../../../user-scripts/${variant}.sh`),
      'utf8',
    );
    const completion = script.match(/^print_completion\(\) \{[\s\S]*?^\}/m)?.[0];
    const installDir = '/test home/.local/share/sonarqube-cli/bin';

    for (const [path, showInstructions] of [
      [installDir, false],
      [`${installDir}:/usr/bin`, false],
      [`/usr/bin:${installDir}:/bin`, false],
      [`/usr/bin:${installDir}`, false],
      ['/usr/bin:/bin', true],
      [`${installDir}-other`, true],
      [`/prefix${installDir}`, true],
      ['', true],
    ] as const) {
      it(`handles PATH=${path}`, () => {
        expect(completion).toBeDefined();
        const result = Bun.spawnSync(
          [
            '/bin/bash',
            '-c',
            `set -euo pipefail
${completion}
INSTALL_DIR=$TEST_INSTALL_DIR
BINARY_NAME=sonar
version=test-version
print_completion`,
          ],
          { env: { PATH: path, TEST_INSTALL_DIR: installDir } },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stderr.toString()).toBe('');
        const output = result.stdout.toString();
        expect(output).toContain('Installation complete!');
        expect(output).toContain(`sonar has been installed to: ${installDir}/sonar`);
        expect(output).toContain("run 'sonar --help'");
        expect(output.includes('What happens next:')).toBe(showInstructions);
        expect(output.includes('export PATH=')).toBe(showInstructions);
        expect(output.includes('Open a new terminal window')).toBe(showInstructions);
      });
    }
  });

  describe.if(isWindows)(`${variant}.ps1 completion`, () => {
    const script = readFileSync(
      join(import.meta.dir, `../../../../user-scripts/${variant}.ps1`),
      'utf8',
    );
    const completion = script.match(/^function Show-Completion \{[\s\S]*?^\}/m)?.[0];
    const installDir = String.raw`C:\Users\Test User\sonarqube-cli\bin`;

    for (const [path, showInstructions] of [
      [installDir, false],
      [`${installDir};C:\\Windows`, false],
      [`C:\\Windows;${installDir};C:\\Other`, false],
      [`C:\\Windows;${installDir}`, false],
      [installDir.toUpperCase(), false],
      [String.raw`C:\Windows`, true],
      [`${installDir}-other`, true],
      [`C:\\prefix${installDir}`, true],
      ['', true],
    ] as const) {
      it(`handles PATH=${path}`, () => {
        expect(completion).toBeDefined();
        const result = Bun.spawnSync(
          [
            'powershell.exe',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `
$ErrorActionPreference = 'Stop'
${completion}
$InstallDir = $env:TEST_INSTALL_DIR
$Dest = "$InstallDir\\sonar.exe"
$Version = 'test-version'
$env:PATH = $env:TEST_PATH
Show-Completion`,
          ],
          { env: { ...process.env, TEST_INSTALL_DIR: installDir, TEST_PATH: path } },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stderr.toString()).toBe('');
        const output = result.stdout.toString();
        expect(output).toContain('Installation complete!');
        expect(output).toContain(`sonar has been installed to: ${installDir}\\sonar.exe`);
        expect(output).toContain("run 'sonar --help'");
        expect(output.includes('What happens next:')).toBe(showInstructions);
        expect(output.includes('$env:PATH =')).toBe(showInstructions);
        expect(output.includes('Open a new terminal window')).toBe(showInstructions);
      });
    }
  });
}
