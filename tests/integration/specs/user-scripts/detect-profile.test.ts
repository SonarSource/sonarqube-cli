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

// Integration tests for the profile-update flow in install.sh.
// Extracts detect_profile() and update_profile() directly from install.sh
// and runs them through bash with controlled HOME/SHELL/ZDOTDIR, so the
// tests exercise the real production code (not a copy of it).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

const scriptPath = join(import.meta.dir, '../../../../user-scripts/install.sh');
const windowsScriptPath = join(import.meta.dir, '../../../../user-scripts/install.ps1');
const prereleaseScriptPath = join(
  import.meta.dir,
  '../../../../user-scripts/install-prerelease.sh',
);
const isWindows = process.platform === 'win32';

const INSTALL_DIR_SUBPATH = '.local/share/sonarqube-cli/bin';
const INSTALL_SH_COMPATIBILITY_VERSION_PATTERN =
  /^\s*version\s*=\s*["'](\d+\.\d+\.\d+\.\d+)["']\s*$/m;
const INSTALL_PS1_COMPATIBILITY_VERSION_PATTERN =
  /^\s*\$SonarVersion\s*=\s*["'](\d+\.\d+\.\d+\.\d+)["']\s*$/im;

function pathLine(installDir: string): string {
  return `export PATH="${installDir}:$PATH"`;
}

/**
 * Runs the real detect_profile() + update_profile() extracted from install.sh.
 * By extracting the functions directly from the production script, the test
 * will break if the script's logic (marker string, comment, messages, etc.)
 * changes without the test being updated.
 *
 * Pass `unsetShell: true` to simulate environments where $SHELL is not set
 * (minimal containers, `env -i`, some CI runners). Bun's runtime always injects
 * SHELL into child processes, so we have to unset it from inside bash.
 */
function runProfileUpdate(
  env: Record<string, string>,
  opts: { unsetShell?: boolean } = {},
): { stdout: string; stderr: string; exitCode: number } {
  const installDir = join(env.HOME ?? '', INSTALL_DIR_SUBPATH);
  const bashSnippet = `
set -euo pipefail
INSTALL_DIR="${installDir}"
${opts.unsetShell ? 'unset SHELL' : ''}
eval "$(sed -n '/^detect_profile()/,/^}/p' "${scriptPath}")"
eval "$(sed -n '/^update_profile()/,/^}/p' "${scriptPath}")"
update_profile
`;
  const proc = Bun.spawnSync(['bash', '-c', bashSnippet], {
    env: { ...env, PATH: process.env.PATH! },
  });
  return {
    stdout: new TextDecoder().decode(proc.stdout).trim(),
    stderr: new TextDecoder().decode(proc.stderr).trim(),
    exitCode: proc.exitCode,
  };
}

function touch(path: string, content = '') {
  writeFileSync(path, content);
}

function readProfile(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe.if(!isWindows)('install.sh profile update', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'detect-profile-test-'));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  describe('bash shell', () => {
    it('appends PATH to .bashrc', () => {
      touch(join(tempHome, '.bashrc'), '# existing config\n');

      const result = runProfileUpdate({ HOME: tempHome, SHELL: '/bin/bash' });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`Updated PATH in: ${join(tempHome, '.bashrc')}`);
      const content = readProfile(join(tempHome, '.bashrc'));
      expect(content).toContain('# existing config');
      expect(content).toContain(pathLine(join(tempHome, INSTALL_DIR_SUBPATH)));
      expect(content).toContain('# Added by sonarqube-cli installer');
    });

    it('appends PATH to .bash_profile on macOS-style setups', () => {
      touch(join(tempHome, '.bash_profile'));

      const result = runProfileUpdate({ HOME: tempHome, SHELL: '/bin/bash' });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`Updated PATH in: ${join(tempHome, '.bash_profile')}`);
      expect(readProfile(join(tempHome, '.bash_profile'))).toContain(
        pathLine(join(tempHome, INSTALL_DIR_SUBPATH)),
      );
    });

    it('prefers .bashrc over .bash_profile', () => {
      touch(join(tempHome, '.bashrc'));
      touch(join(tempHome, '.bash_profile'));

      const result = runProfileUpdate({ HOME: tempHome, SHELL: '/bin/bash' });

      expect(result.stdout).toBe(`Updated PATH in: ${join(tempHome, '.bashrc')}`);
      expect(readProfile(join(tempHome, '.bashrc'))).toContain(
        pathLine(join(tempHome, INSTALL_DIR_SUBPATH)),
      );
      expect(readProfile(join(tempHome, '.bash_profile'))).not.toContain(
        pathLine(join(tempHome, INSTALL_DIR_SUBPATH)),
      );
    });
  });

  describe('zsh shell', () => {
    it('appends PATH to .zshrc', () => {
      touch(join(tempHome, '.zshrc'));

      const result = runProfileUpdate({ HOME: tempHome, SHELL: '/bin/zsh' });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`Updated PATH in: ${join(tempHome, '.zshrc')}`);
      expect(readProfile(join(tempHome, '.zshrc'))).toContain(
        pathLine(join(tempHome, INSTALL_DIR_SUBPATH)),
      );
    });

    it('appends PATH to .zprofile under ZDOTDIR (reported bug)', () => {
      const zdotdir = join(tempHome, '.config', 'zsh');
      mkdirSync(zdotdir, { recursive: true });
      touch(join(zdotdir, '.zprofile'), '# zsh profile\n');

      const result = runProfileUpdate({
        HOME: tempHome,
        SHELL: '/bin/zsh',
        ZDOTDIR: zdotdir,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`Updated PATH in: ${join(zdotdir, '.zprofile')}`);
      const content = readProfile(join(zdotdir, '.zprofile'));
      expect(content).toContain('# zsh profile');
      expect(content).toContain(pathLine(join(tempHome, INSTALL_DIR_SUBPATH)));
    });

    it('prefers ZDOTDIR/.zshrc over HOME/.zshrc', () => {
      const zdotdir = join(tempHome, '.config', 'zsh');
      mkdirSync(zdotdir, { recursive: true });
      touch(join(tempHome, '.zshrc'));
      touch(join(zdotdir, '.zshrc'));

      const result = runProfileUpdate({
        HOME: tempHome,
        SHELL: '/bin/zsh',
        ZDOTDIR: zdotdir,
      });

      expect(result.stdout).toBe(`Updated PATH in: ${join(zdotdir, '.zshrc')}`);
      expect(readProfile(join(zdotdir, '.zshrc'))).toContain(
        pathLine(join(tempHome, INSTALL_DIR_SUBPATH)),
      );
      expect(readProfile(join(tempHome, '.zshrc'))).not.toContain(
        pathLine(join(tempHome, INSTALL_DIR_SUBPATH)),
      );
    });
  });

  describe('duplicate guard', () => {
    it('skips if PATH entry already present', () => {
      touch(
        join(tempHome, '.bashrc'),
        `existing\n${pathLine(join(tempHome, INSTALL_DIR_SUBPATH))}\n`,
      );

      const result = runProfileUpdate({ HOME: tempHome, SHELL: '/bin/bash' });

      expect(result.stdout).toBe(`Already present in ${join(tempHome, '.bashrc')}, skipping.`);
      const content = readProfile(join(tempHome, '.bashrc'));
      const matches = content.match(/sonarqube-cli\/bin/g);
      expect(matches).toHaveLength(1);
    });

    it('does not double-append on second run', () => {
      touch(join(tempHome, '.bashrc'));

      runProfileUpdate({ HOME: tempHome, SHELL: '/bin/bash' });
      const result = runProfileUpdate({ HOME: tempHome, SHELL: '/bin/bash' });

      expect(result.stdout).toBe(`Already present in ${join(tempHome, '.bashrc')}, skipping.`);
      const content = readProfile(join(tempHome, '.bashrc'));
      const matches = content.match(/sonarqube-cli\/bin/g);
      expect(matches).toHaveLength(1);
    });
  });

  describe('no profile found', () => {
    it('reports no profile when HOME is empty', () => {
      const result = runProfileUpdate({ HOME: tempHome, SHELL: '/bin/bash' });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No shell profile files found.');
      expect(result.stdout).toContain(pathLine(join(tempHome, INSTALL_DIR_SUBPATH)));
    });
  });

  describe('PROFILE override', () => {
    it('uses explicit PROFILE path', () => {
      const custom = join(tempHome, 'my-shell-profile');
      touch(custom);

      const result = runProfileUpdate({
        HOME: tempHome,
        SHELL: '/bin/bash',
        PROFILE: custom,
      });

      expect(result.stdout).toBe(`Updated PATH in: ${custom}`);
      expect(readProfile(custom)).toContain(pathLine(join(tempHome, INSTALL_DIR_SUBPATH)));
    });

    it('skips profile update when PROFILE is /dev/null', () => {
      touch(join(tempHome, '.bashrc'));

      const result = runProfileUpdate({
        HOME: tempHome,
        SHELL: '/bin/bash',
        PROFILE: '/dev/null',
      });

      expect(result.stdout).toContain('No shell profile files found.');
      expect(readProfile(join(tempHome, '.bashrc'))).not.toContain(
        pathLine(join(tempHome, INSTALL_DIR_SUBPATH)),
      );
    });
  });

  describe('sync check between install scripts', () => {
    const extract = (path: string, fn: string) => {
      const proc = Bun.spawnSync(['sed', '-n', `/^${fn}()/,/^}/p`, path]);
      return new TextDecoder().decode(proc.stdout).trim();
    };

    it('install.sh and install-prerelease.sh define the same detect_profile()', () => {
      expect(extract(scriptPath, 'detect_profile')).toBe(
        extract(prereleaseScriptPath, 'detect_profile'),
      );
    });

    it('install.sh and install-prerelease.sh define the same update_profile()', () => {
      expect(extract(scriptPath, 'update_profile')).toBe(
        extract(prereleaseScriptPath, 'update_profile'),
      );
    });
  });

  describe('unset or empty SHELL', () => {
    it('does not crash under set -u when SHELL is unset', () => {
      touch(join(tempHome, '.profile'));

      const result = runProfileUpdate({ HOME: tempHome }, { unsetShell: true });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain('unbound variable');
      expect(result.stdout).toBe(`Updated PATH in: ${join(tempHome, '.profile')}`);
      expect(readProfile(join(tempHome, '.profile'))).toContain(
        pathLine(join(tempHome, INSTALL_DIR_SUBPATH)),
      );
    });

    it('falls through to generic fallback when SHELL is empty', () => {
      touch(join(tempHome, '.profile'));

      const result = runProfileUpdate({ HOME: tempHome, SHELL: '' });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain('unbound variable');
      expect(result.stdout).toBe(`Updated PATH in: ${join(tempHome, '.profile')}`);
    });

    it('reports no profile when SHELL is unset and HOME has no profile files', () => {
      const result = runProfileUpdate({ HOME: tempHome }, { unsetShell: true });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain('unbound variable');
      expect(result.stdout).toContain('No shell profile files found.');
    });
  });

  describe('generic fallback', () => {
    it('falls back to .profile for unknown shells', () => {
      touch(join(tempHome, '.profile'));

      const result = runProfileUpdate({ HOME: tempHome, SHELL: '/bin/fish' });

      expect(result.stdout).toBe(`Updated PATH in: ${join(tempHome, '.profile')}`);
      expect(readProfile(join(tempHome, '.profile'))).toContain(
        pathLine(join(tempHome, INSTALL_DIR_SUBPATH)),
      );
    });

    it('does not leak ZDOTDIR into fallback for non-zsh shells', () => {
      const zdotdir = join(tempHome, '.config', 'zsh');
      mkdirSync(zdotdir, { recursive: true });
      touch(join(zdotdir, '.zshrc'));
      touch(join(tempHome, '.profile'));

      const result = runProfileUpdate({
        HOME: tempHome,
        SHELL: '/bin/fish',
        ZDOTDIR: zdotdir,
      });

      expect(result.stdout).toBe(`Updated PATH in: ${join(tempHome, '.profile')}`);
      expect(readProfile(join(tempHome, '.profile'))).toContain(
        pathLine(join(tempHome, INSTALL_DIR_SUBPATH)),
      );
      expect(readProfile(join(zdotdir, '.zshrc'))).not.toContain(
        pathLine(join(tempHome, INSTALL_DIR_SUBPATH)),
      );
    });
  });
});

describe('install script self-update compatibility markers', () => {
  it('keeps the legacy version marker in install.sh', () => {
    const scriptContent = readFileSync(scriptPath, 'utf-8');
    const match = scriptContent.match(INSTALL_SH_COMPATIBILITY_VERSION_PATTERN);

    expect(scriptContent).toContain('Older self-update implementations');
    expect(scriptContent).toContain('stable.version at runtime');
    expect(match?.[1]).toBeDefined();
  });

  it('keeps the legacy version marker in install.ps1', () => {
    const scriptContent = readFileSync(windowsScriptPath, 'utf-8');
    const match = scriptContent.match(INSTALL_PS1_COMPATIBILITY_VERSION_PATTERN);

    expect(scriptContent).toContain('Older self-update implementations');
    expect(scriptContent).toContain('stable.version at runtime');
    expect(match?.[1]).toBeDefined();
  });

  it('keeps the same compatibility version in both install scripts', () => {
    const installSh = readFileSync(scriptPath, 'utf-8');
    const installPs1 = readFileSync(windowsScriptPath, 'utf-8');
    const installShVersion = installSh.match(INSTALL_SH_COMPATIBILITY_VERSION_PATTERN)?.[1];
    const installPs1Version = installPs1.match(INSTALL_PS1_COMPATIBILITY_VERSION_PATTERN)?.[1];

    expect(installShVersion).toBeDefined();
    expect(installPs1Version).toBeDefined();
    expect(installShVersion).toBe(installPs1Version);
  });
});
