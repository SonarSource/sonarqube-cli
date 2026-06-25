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

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../../src/ui';

// Mock node:child_process before importing self-update so that the named
// imports (spawn, spawnSync) in self-update.ts resolve to the test doubles.
const childProcess = await import('node:child_process');
type MockChildProcess = EventEmitter & { unref: () => void };
type MockSpawnSyncResult = { status: number | null; error?: Error };

function createSpawnChild(
  outcome: 'spawn' | 'error' = 'spawn',
  errorMessage = 'spawn failed',
): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.unref = () => {};
  queueMicrotask(() => {
    if (outcome === 'spawn') {
      child.emit('spawn');
    } else {
      child.emit('error', new Error(errorMessage));
    }
  });
  return child;
}

const spawnMock = mock(() => createSpawnChild());
const spawnSyncMock = mock((): MockSpawnSyncResult => ({ status: 0 }));
void mock.module('node:child_process', () => ({
  ...childProcess,
  spawn: spawnMock as unknown as typeof childProcess.spawn,
  spawnSync: spawnSyncMock as unknown as typeof childProcess.spawnSync,
}));

// Mock platform-detector so both Unix and Windows branches are reachable on any OS.
const platformDetector = await import('../../../../../src/lib/platform-detector.js');
const isWindowsMock = mock(() => false);
void mock.module('../../../../../src/lib/platform-detector.js', () => ({
  ...platformDetector,
  isWindows: isWindowsMock,
}));

// Mock the shared version helpers used by the CLI Version class.
const { isNewerVersion: realIsNewerVersion, stripBuildNumber: realStripBuildNumber } =
  await import('../../../../../src/lib/version');
void mock.module('../../../../../src/lib/version', () => ({
  isNewerVersion: mock(realIsNewerVersion),
  stripBuildNumber: mock(realStripBuildNumber),
}));

const { checkForUpdate } = await import('../../../../../src/cli/commands/self-update/update-check');
const { selfUpdate } = await import('../../../../../src/cli/commands/self-update');

describe('checkForUpdate', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns the latest update and marks upToDate false when stable.version is newer', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => Promise.resolve('99.0.0.241\n'),
    });

    const result = await checkForUpdate();

    expect(result.latest.version.text).toBe('99.0.0.241');
    expect(result.latest.version.noBuild.text).toBe('99.0.0');
    expect(String(result.currentVersion)).toBe(
      (await import('../../../../../package.json')).version,
    );
    expect(result.upToDate).toBe(false);
  });

  it('returns the latest update and marks upToDate true when the current version matches', async () => {
    // Same major.minor.patch as current; build number must be ignored.
    const [major, minor, patch] = (await import('../../../../../package.json')).version.split('.');
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => Promise.resolve(`${major}.${minor}.${patch}.999\n`),
    });

    const result = await checkForUpdate();

    expect(result.latest.version.text).toBe(`${major}.${minor}.${patch}.999`);
    expect(result.latest.version.noBuild.text).toBe(`${major}.${minor}.${patch}`);
    expect(result.upToDate).toBe(true);
  });

  it('throws on HTTP error', () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 404 });

    expect(checkForUpdate()).rejects.toThrow('HTTP 404');
  });

  it('throws when stable.version is not a version', () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => Promise.resolve('not-a-version'),
    });

    expect(checkForUpdate()).rejects.toThrow('Could not determine the latest version');
  });
});

describe('selfUpdate --status', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    setMockUi(false);
  });

  it('reports an available update without installing', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => Promise.resolve('99.0.0.241\n'),
    });

    await selfUpdate({ status: true });

    const messages = getMockUiCalls().map((c) => c.args.join(' '));
    // Build number must be stripped from displayed versions
    expect(messages.some((m) => m.includes('99.0.0') && !m.includes('99.0.0.241'))).toBe(true);
    expect(messages.some((m) => /update available/i.test(m))).toBe(true);
  });

  it('reports already up to date', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => Promise.resolve('0.0.1\n'),
    });

    await selfUpdate({ status: true });

    const messages = getMockUiCalls().map((c) => c.args.join(' '));
    expect(messages.some((m) => /up to date/i.test(m))).toBe(true);
  });
});

describe('selfUpdate --force', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    spawnMock.mockClear();
    spawnMock.mockImplementation(() => createSpawnChild());
    spawnSyncMock.mockClear();
    isWindowsMock.mockImplementation(() => false);
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    setMockUi(false);
  });

  async function runForce(
    latestVersion: string,
    scriptContent = '#!/usr/bin/env bash\necho hi\n',
  ): Promise<void> {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      text: async () => Promise.resolve(`${latestVersion}\n`),
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      text: async () => Promise.resolve(scriptContent),
    });
    await selfUpdate({ force: true });
  }

  it('installs even when already up to date', async () => {
    const [major, minor, patch] = (await import('../../../../../package.json')).version.split('.');
    await runForce(`${major}.${minor}.${patch}.999`);

    const messages = getMockUiCalls().map((c) => c.args.join(' '));
    expect(messages.some((m) => /up to date/i.test(m))).toBe(false);
    expect(messages.some((m) => /force/i.test(m))).toBe(true);
  });

  it('shows the normal update message when an update is also available', async () => {
    await runForce('99.0.0.241');

    const messages = getMockUiCalls().map((c) => c.args.join(' '));
    expect(messages.some((m) => /updating/i.test(m) && m.includes('99.0.0'))).toBe(true);
    expect(messages.some((m) => m.includes('99.0.0.241'))).toBe(false);
  });

  it('emits a success message after a successful Unix update', async () => {
    await runForce('2.0.0.241');

    const messages = getMockUiCalls().map((c) => c.args.join(' '));
    expect(messages.some((m) => m.includes('Updated to v2.0.0'))).toBe(true);
    expect(messages.some((m) => m.includes('Updated to v2.0.0.241'))).toBe(false);
  });

  it('throws for non-Windows install when the update script exits with an error', async () => {
    spawnSyncMock.mockReturnValue({ status: 12 });

    try {
      await runForce('2.0.0');
      throw new Error('Expected selfUpdate to fail');
    } catch (error) {
      expect((error as Error).message).toContain('Update script exited with code 12');
    }
  });

  it('throws the underlying spawn error when the update script cannot be started', async () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      error: new Error('spawnSync /bin/bash ENOENT'),
    });

    try {
      await runForce('2.0.0');
      throw new Error('Expected selfUpdate to fail');
    } catch (error) {
      expect((error as Error).message).toContain(
        'Failed to start update script: spawnSync /bin/bash ENOENT',
      );
    }
  });

  it('confirms update launched in new terminal on Windows', async () => {
    isWindowsMock.mockImplementation(() => true);
    await runForce('2.0.0', 'Write-Host hi\n');

    const messages = getMockUiCalls().map((c) => c.args.join(' '));
    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(
      messages.some((m) =>
        m.includes('Check the new terminal window to confirm the update completed.'),
      ),
    ).toBe(true);
    expect(spawnMock).toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(args).toContain('-Command');
    expect(args.at(-1)).toContain('Remove-Item -Force');
  });

  it('throws when the Windows updater terminal cannot be launched', async () => {
    isWindowsMock.mockImplementation(() => true);
    spawnMock.mockImplementation(() => createSpawnChild('error', 'spawn cmd.exe ENOENT'));

    try {
      await runForce('2.0.0', 'Write-Host hi\n');
      throw new Error('Expected selfUpdate to fail');
    } catch (error) {
      expect((error as Error).message).toContain(
        'Failed to start update script: spawn cmd.exe ENOENT',
      );
    }

    const messages = getMockUiCalls().map((c) => c.args.join(' '));
    expect(messages.some((m) => m.includes('Starting update in a new terminal window...'))).toBe(
      false,
    );
  });
});
