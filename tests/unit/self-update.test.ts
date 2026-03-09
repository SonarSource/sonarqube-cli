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

import { mock, describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../src/ui';

// Mock node:child_process before importing self-update so that the named
// imports (spawn, spawnSync) in self-update.ts resolve to the test doubles.
const childProcess = await import('node:child_process');
const spawnMock = mock(() => ({ unref: () => {} }));
const spawnSyncMock = mock(() => ({ status: 0 }));
void mock.module('node:child_process', () => ({
  ...childProcess,
  spawn: spawnMock as unknown as typeof childProcess.spawn,
  spawnSync: spawnSyncMock as unknown as typeof childProcess.spawnSync,
}));

const { extractVersion, isNewerVersion, stripBuildNumber, checkForUpdate, selfUpdate } =
  await import('../../src/cli/commands/self-update');

describe('extractVersion', () => {
  it('extracts version from a shell script (double quotes)', () => {
    const script = `#!/usr/bin/env bash\nversion="1.5.0"\necho "installing $version"`;
    expect(extractVersion(script)).toBe('1.5.0');
  });

  it('extracts version from a shell script (single quotes)', () => {
    const script = `version='2.0.1'\necho hi`;
    expect(extractVersion(script)).toBe('2.0.1');
  });

  it('extracts $SonarVersion from a PowerShell script', () => {
    const script = `$SonarVersion = "1.10.3"\nWrite-Host "installing $SonarVersion"`;
    expect(extractVersion(script)).toBe('1.10.3');
  });

  it('extracts $sonarversion (case-insensitive) from a PowerShell script', () => {
    const script = `$sonarversion = "0.9.0"\nWrite-Host $sonarversion`;
    expect(extractVersion(script)).toBe('0.9.0');
  });

  it('returns null when no version is found', () => {
    expect(extractVersion('#!/usr/bin/env bash\necho "hello"')).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('returns true when candidate has a higher major', () => {
    expect(isNewerVersion('1.0.0', '2.0.0')).toBe(true);
  });

  it('returns true when candidate has a higher minor', () => {
    expect(isNewerVersion('1.2.0', '1.3.0')).toBe(true);
  });

  it('returns true when candidate has a higher patch', () => {
    expect(isNewerVersion('1.2.3', '1.2.4')).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
  });

  it('returns false when current is higher', () => {
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(false);
  });

  it('handles four-segment versions', () => {
    expect(isNewerVersion('1.2.3.0', '1.2.3.1')).toBe(true);
    expect(isNewerVersion('1.2.3.1', '1.2.3.0')).toBe(false);
  });

  it('treats a missing segment as 0', () => {
    expect(isNewerVersion('1.2.3', '1.2.3.0')).toBe(false);
    expect(isNewerVersion('1.2.3', '1.2.3.1')).toBe(true);
  });
});

describe('stripBuildNumber', () => {
  it('removes the 4th segment from a version with a build number', () => {
    expect(stripBuildNumber('0.5.0.241')).toBe('0.5.0');
  });

  it('leaves a 3-segment version unchanged', () => {
    expect(stripBuildNumber('1.2.3')).toBe('1.2.3');
  });

  it('leaves a 2-segment version unchanged', () => {
    expect(stripBuildNumber('1.2')).toBe('1.2');
  });
});

describe('checkForUpdate', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns updateAvailable: true when latest > current (with build number)', async () => {
    const scriptContent = 'version="99.0.0.241"\necho hi';
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => Promise.resolve(scriptContent),
    } as Response);

    const result = await checkForUpdate();

    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe('99.0.0.241');
    expect(result.scriptContent).toBe(scriptContent);
    expect(result.scriptName).toMatch(/install\.(sh|ps1)$/);
  });

  it('returns updateAvailable: false when latest matches current (with build number)', async () => {
    // Same major.minor.patch as current; build number must be ignored.
    const [major, minor, patch] = (await import('../../package.json')).version.split('.');
    const scriptContent = `version="${major}.${minor}.${patch}.999"\necho hi`;
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => Promise.resolve(scriptContent),
    } as Response);

    const result = await checkForUpdate();

    expect(result.updateAvailable).toBe(false);
    expect(result.latestVersion).toMatch(/\.\d+$/); // still contains build number for display
  });

  it('throws on HTTP error', () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 404 } as Response);

    expect(checkForUpdate()).rejects.toThrow('HTTP 404');
  });

  it('throws when version cannot be extracted from the script', () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => Promise.resolve('#!/bin/bash\necho "no version here"'),
    } as Response);

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
      text: async () => Promise.resolve('version="99.0.0.241"\necho hi'),
    } as Response);

    await selfUpdate({ status: true });

    const messages = getMockUiCalls().map((c) => c.args.join(' '));
    // Build number must be stripped from displayed versions
    expect(messages.some((m) => m.includes('99.0.0') && !m.includes('99.0.0.241'))).toBe(true);
    expect(messages.some((m) => /update available/i.test(m))).toBe(true);
  });

  it('reports already up to date', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => Promise.resolve('version="0.0.1"\necho hi'),
    } as Response);

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
    spawnSyncMock.mockClear();
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    setMockUi(false);
  });

  // On Windows the install spawns a detached child then throws CommandFailedError(exitCode=0)
  // so runCommand() can set the exit code and let telemetry run before the process exits.
  // Tests catch that throw and verify the UI messages printed before it.
  async function runForce(scriptContent: string): Promise<void> {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => Promise.resolve(scriptContent),
    } as Response);
    try {
      await selfUpdate({ force: true });
    } catch (err) {
      if ((err as { exitCode?: number }).exitCode !== 0) throw err;
    }
  }

  it('installs even when already up to date', async () => {
    await runForce('version="0.0.1"\necho hi');

    const messages = getMockUiCalls().map((c) => c.args.join(' '));
    expect(messages.some((m) => /up to date/i.test(m))).toBe(false);
    expect(messages.some((m) => /force/i.test(m))).toBe(true);
  });

  it('shows the normal update message when an update is also available', async () => {
    await runForce('version="99.0.0"\necho hi');

    const messages = getMockUiCalls().map((c) => c.args.join(' '));
    expect(messages.some((m) => /updating/i.test(m))).toBe(true);
  });
});
