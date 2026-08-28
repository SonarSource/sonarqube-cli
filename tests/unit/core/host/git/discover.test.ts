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

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, spyOn } from 'bun:test';

import { findGitRoot, getGitRemote } from '@/core/host/git/discover.ts';
import * as processLib from '@/core/process/process.ts';

describe('getGitRemote', () => {
  it('reads the origin remote URL when git succeeds', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: 'https://github.com/example/test-project.git\n',
      stderr: '',
    });

    try {
      expect(await getGitRemote('/repo')).toBe('https://github.com/example/test-project.git');
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('returns an empty string when the git spawn fails', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockRejectedValue(
      new Error('git not available'),
    );

    try {
      expect(await getGitRemote('/repo')).toBe('');
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('returns an empty string when git exits non-zero (no origin configured)', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'no origin',
    });

    try {
      expect(await getGitRemote('/repo')).toBe('');
    } finally {
      spawnSpy.mockRestore();
    }
  });
});

describe('findGitRoot', () => {
  it('detects a git repository when a .git directory is present', () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-findgitroot-' + Date.now());
    mkdirSync(join(testDir, '.git'), { recursive: true });

    try {
      expect(findGitRoot(testDir)).toEqual({ gitRoot: testDir, isGit: true });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
