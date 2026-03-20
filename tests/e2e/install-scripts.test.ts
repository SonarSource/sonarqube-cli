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

// Real-network test for install.sh — validates URL path structure on binaries.sonarsource.com

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scriptDir = join(import.meta.dir, '../../user-scripts');

describe.if(process.platform !== 'win32')('install.sh (network)', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'sonar-install-test-'));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it(
    'downloads and installs sonar CLI binary on the current platform',
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
    { timeout: 120000 },
  );
});
