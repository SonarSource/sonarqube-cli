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

// Tests for performSelfUpdate in src/lib/self-update.ts
// Uses mock.module to intercept filesystem and process calls.

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

// ── Mutable state read by the module-level mocks below ─────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpawnResult = { exitCode: number; stdout: string; stderr: string };

let _existsSyncImpl: (p: string) => boolean = () => false;
let _spawnProcessImpl: () => Promise<SpawnResult> = async () => {
  throw new Error('Binary execution failed');
};

// Track calls to rename and unlink so tests can assert on them.
const _renameCalls: Array<[string, string]> = [];
const _unlinkCalls: string[] = [];

// ── Module mocks (hoisted by Bun before any import resolves) ────────────────

mock.module('node:fs', () => ({
  existsSync: (p: string) => _existsSyncImpl(p),
}));

mock.module('node:fs/promises', () => ({
  mkdtemp: async () => '/tmp/sonar-test',
  writeFile: async () => undefined,
  copyFile: async () => undefined,
  chmod: async () => undefined,
  rename: async (from: string, to: string) => {
    _renameCalls.push([from, to]);
  },
  unlink: async (p: string) => {
    _unlinkCalls.push(p);
  },
  rm: async () => undefined,
}));

mock.module('../../src/lib/process.js', () => ({
  spawnProcess: async (cmd: string, args: string[]) => {
    if (cmd === 'xattr') {
      // removeQuarantine — let it succeed silently
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return _spawnProcessImpl();
  },
}));

// ── Subject under test (imported after mocks are in place) ──────────────────

import { performSelfUpdate } from '../../src/lib/self-update.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function resetCallTrackers() {
  _renameCalls.length = 0;
  _unlinkCalls.length = 0;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('performSelfUpdate', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    resetCallTrackers();

    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    } as Response);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  describe('rollback on verification failure', () => {
    beforeEach(() => {
      _spawnProcessImpl = async () => {
        throw new Error('downloaded binary failed version check');
      };
    });

    it('removes the failed binary when there was no original binary to restore', async () => {
      const currentBinaryPath = process.execPath;

      // No original binary at any path
      _existsSyncImpl = () => false;

      await expect(performSelfUpdate('1.0.0')).rejects.toThrow('downloaded binary failed version check');

      // The failed binary placed at currentBinaryPath must be removed
      expect(_unlinkCalls).toContain(currentBinaryPath);

      // No backup-restore rename should have happened
      const backupPath = `${currentBinaryPath}.backup`;
      const restoredFromBackup = _renameCalls.some(([from, to]) => from === backupPath && to === currentBinaryPath);
      expect(restoredFromBackup).toBe(false);
    });

    it('restores the backup when the original binary existed before the update', async () => {
      const currentBinaryPath = process.execPath;
      const backupPath = `${currentBinaryPath}.backup`;

      // Current binary exists → a backup will be created; backup also exists during rollback
      _existsSyncImpl = (p: string) => p === currentBinaryPath || p === backupPath;

      await expect(performSelfUpdate('1.0.0')).rejects.toThrow('downloaded binary failed version check');

      // Backup must have been created (renamed current → backup)
      const backupCreated = _renameCalls.some(([from, to]) => from === currentBinaryPath && to === backupPath);
      expect(backupCreated).toBe(true);

      // Backup must have been restored (renamed backup → current)
      const backupRestored = _renameCalls.some(([from, to]) => from === backupPath && to === currentBinaryPath);
      expect(backupRestored).toBe(true);

      // The failed binary should NOT have been unlinked during rollback
      expect(_unlinkCalls).not.toContain(currentBinaryPath);
    });
  });

  describe('successful update', () => {
    beforeEach(() => {
      _spawnProcessImpl = async () => ({ exitCode: 0, stdout: '1.0.0', stderr: '' });
    });

    it('removes the backup after a successful update when an original binary existed', async () => {
      const currentBinaryPath = process.execPath;
      const backupPath = `${currentBinaryPath}.backup`;

      // Current binary exists initially, backup exists after the swap
      _existsSyncImpl = (p: string) => p === currentBinaryPath || p === backupPath;

      const version = await performSelfUpdate('1.0.0');

      expect(version).toBe('1.0.0');
      expect(_unlinkCalls).toContain(backupPath);
    });

    it('does not attempt to remove a backup when no original binary existed', async () => {
      const currentBinaryPath = process.execPath;
      const backupPath = `${currentBinaryPath}.backup`;

      _existsSyncImpl = () => false;

      const version = await performSelfUpdate('1.0.0');

      expect(version).toBe('1.0.0');
      expect(_unlinkCalls).not.toContain(backupPath);
    });
  });
});
