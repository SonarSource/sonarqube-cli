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

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scriptPath = join(import.meta.dir, '../../../user-scripts/install.sh');
const isWindows = process.platform === 'win32';

function runDetectProfile(env: Record<string, string>): string {
  const bashSnippet = [
    'set -euo pipefail',
    `eval "$(sed -n '/^detect_profile()/,/^}/p' "${scriptPath}")"`,
    'detect_profile',
  ].join('\n');
  const proc = Bun.spawnSync(['bash', '-c', bashSnippet], {
    env: { ...env, PATH: process.env.PATH! },
  });
  return new TextDecoder().decode(proc.stdout).trim();
}

function touch(path: string) {
  writeFileSync(path, '');
}

describe.if(!isWindows)('detect_profile()', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'detect-profile-test-'));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  describe('PROFILE override', () => {
    it('returns nothing when PROFILE is /dev/null', () => {
      touch(join(tempHome, '.bashrc'));
      const result = runDetectProfile({
        HOME: tempHome,
        SHELL: '/bin/bash',
        PROFILE: '/dev/null',
      });
      expect(result).toBe('');
    });

    it('returns PROFILE when set to an existing file', () => {
      const customProfile = join(tempHome, 'my-custom-profile');
      touch(customProfile);
      const result = runDetectProfile({
        HOME: tempHome,
        SHELL: '/bin/bash',
        PROFILE: customProfile,
      });
      expect(result).toBe(customProfile);
    });

    it('ignores PROFILE when file does not exist', () => {
      touch(join(tempHome, '.bashrc'));
      const result = runDetectProfile({
        HOME: tempHome,
        SHELL: '/bin/bash',
        PROFILE: join(tempHome, 'nonexistent'),
      });
      expect(result).toBe(join(tempHome, '.bashrc'));
    });
  });

  describe('bash shell', () => {
    it('detects .bashrc', () => {
      touch(join(tempHome, '.bashrc'));
      const result = runDetectProfile({ HOME: tempHome, SHELL: '/bin/bash' });
      expect(result).toBe(join(tempHome, '.bashrc'));
    });

    it('detects .bash_profile when .bashrc is missing', () => {
      touch(join(tempHome, '.bash_profile'));
      const result = runDetectProfile({ HOME: tempHome, SHELL: '/bin/bash' });
      expect(result).toBe(join(tempHome, '.bash_profile'));
    });

    it('prefers .bashrc over .bash_profile', () => {
      touch(join(tempHome, '.bashrc'));
      touch(join(tempHome, '.bash_profile'));
      const result = runDetectProfile({ HOME: tempHome, SHELL: '/bin/bash' });
      expect(result).toBe(join(tempHome, '.bashrc'));
    });
  });

  describe('zsh shell', () => {
    it('detects .zshrc in HOME', () => {
      touch(join(tempHome, '.zshrc'));
      const result = runDetectProfile({ HOME: tempHome, SHELL: '/bin/zsh' });
      expect(result).toBe(join(tempHome, '.zshrc'));
    });

    it('detects .zprofile when .zshrc is missing', () => {
      touch(join(tempHome, '.zprofile'));
      const result = runDetectProfile({ HOME: tempHome, SHELL: '/bin/zsh' });
      expect(result).toBe(join(tempHome, '.zprofile'));
    });

    it('prefers .zshrc over .zprofile', () => {
      touch(join(tempHome, '.zshrc'));
      touch(join(tempHome, '.zprofile'));
      const result = runDetectProfile({ HOME: tempHome, SHELL: '/bin/zsh' });
      expect(result).toBe(join(tempHome, '.zshrc'));
    });

    it('detects .zshrc under ZDOTDIR', () => {
      const zdotdir = join(tempHome, '.config', 'zsh');
      mkdirSync(zdotdir, { recursive: true });
      touch(join(zdotdir, '.zshrc'));
      const result = runDetectProfile({
        HOME: tempHome,
        SHELL: '/bin/zsh',
        ZDOTDIR: zdotdir,
      });
      expect(result).toBe(join(zdotdir, '.zshrc'));
    });

    it('detects .zprofile under ZDOTDIR', () => {
      const zdotdir = join(tempHome, '.config', 'zsh');
      mkdirSync(zdotdir, { recursive: true });
      touch(join(zdotdir, '.zprofile'));
      const result = runDetectProfile({
        HOME: tempHome,
        SHELL: '/bin/zsh',
        ZDOTDIR: zdotdir,
      });
      expect(result).toBe(join(zdotdir, '.zprofile'));
    });

    it('prefers ZDOTDIR over HOME', () => {
      const zdotdir = join(tempHome, '.config', 'zsh');
      mkdirSync(zdotdir, { recursive: true });
      touch(join(tempHome, '.zshrc'));
      touch(join(zdotdir, '.zshrc'));
      const result = runDetectProfile({
        HOME: tempHome,
        SHELL: '/bin/zsh',
        ZDOTDIR: zdotdir,
      });
      expect(result).toBe(join(zdotdir, '.zshrc'));
    });
  });

  describe('generic fallback', () => {
    it('falls back to .profile for unknown shell', () => {
      touch(join(tempHome, '.profile'));
      const result = runDetectProfile({ HOME: tempHome, SHELL: '/bin/fish' });
      expect(result).toBe(join(tempHome, '.profile'));
    });

    it('falls back to .bashrc when shell has no specific match', () => {
      touch(join(tempHome, '.bashrc'));
      const result = runDetectProfile({ HOME: tempHome, SHELL: '/bin/fish' });
      expect(result).toBe(join(tempHome, '.bashrc'));
    });

    it('respects fallback priority order', () => {
      touch(join(tempHome, '.bash_profile'));
      touch(join(tempHome, '.zprofile'));
      const result = runDetectProfile({ HOME: tempHome, SHELL: '/bin/fish' });
      expect(result).toBe(join(tempHome, '.bash_profile'));
    });

    it('returns nothing when no profile files exist', () => {
      const result = runDetectProfile({ HOME: tempHome, SHELL: '/bin/bash' });
      expect(result).toBe('');
    });

    it('does not leak ZDOTDIR into fallback for non-zsh shells', () => {
      const zdotdir = join(tempHome, '.config', 'zsh');
      mkdirSync(zdotdir, { recursive: true });
      touch(join(zdotdir, '.zshrc'));
      touch(join(tempHome, '.profile'));
      const result = runDetectProfile({
        HOME: tempHome,
        SHELL: '/bin/fish',
        ZDOTDIR: zdotdir,
      });
      expect(result).toBe(join(tempHome, '.profile'));
    });
  });
});
