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

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UPDATE_SCRIPT_BASE_URL } from '../../lib/config-constants';
import { info } from '../../ui';

export async function selfUpdate(): Promise<void> {
  const isWindows = process.platform === 'win32';
  const scriptName = isWindows ? 'install.ps1' : 'install.sh';
  const scriptUrl = `${UPDATE_SCRIPT_BASE_URL}/${scriptName}`;

  info('Downloading latest install script...');

  const response = await fetch(scriptUrl);
  if (!response.ok) {
    throw new Error(`Failed to download update script: HTTP ${response.status}`);
  }

  const scriptContent = await response.text();
  const tempPath = join(tmpdir(), scriptName);

  if (isWindows) {
    // On Windows the running binary is file-locked, so the parent must exit
    // before the script can overwrite it. Open PowerShell in a new window so
    // it has its own console and the user can see the output.
    writeFileSync(tempPath, scriptContent, 'utf8');
    info('Starting update in a new terminal window...');
    const child = spawn(
      'cmd',
      ['/c', 'start', 'powershell', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', tempPath],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    process.exit(0);
  } else {
    // On Unix the binary is not locked, so run the script synchronously and
    // stream its output directly to the terminal.
    writeFileSync(tempPath, scriptContent, { encoding: 'utf8', mode: 0o755 });
    const result = spawnSync('bash', [tempPath], { stdio: 'inherit' });
    if (result.status !== 0) {
      throw new Error(`Update script exited with code ${String(result.status ?? 'unknown')}`);
    }
  }
}
