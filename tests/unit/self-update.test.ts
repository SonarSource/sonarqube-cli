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

// Tests for src/lib/self-update.ts

import { describe, it, expect, spyOn, afterEach, mock } from 'bun:test';
import { compareVersions, fetchLatestCliVersion, performSelfUpdate } from '../../src/lib/self-update.js';
import * as processLib from '../../src/lib/process.js';

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('0.0.1', '0.0.1')).toBe(0);
  });

  it('returns negative when a is less than b', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareVersions('0.9.0', '1.0.0')).toBeLessThan(0);
  });

  it('returns positive when a is greater than b', () => {
    expect(compareVersions('2.0.0', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.9.0')).toBeGreaterThan(0);
  });

  it('compares minor/patch segments numerically, not lexicographically', () => {
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.9', '1.0.10')).toBeLessThan(0);
  });
});

describe('fetchLatestCliVersion', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('returns the trimmed version string on success', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '1.5.0\n',
    } as Response);

    const version = await fetchLatestCliVersion();
    expect(version).toBe('1.5.0');
  });

  it('throws when the server returns a non-OK response', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    } as Response);

    expect(fetchLatestCliVersion()).rejects.toThrow('Failed to fetch latest version: 503 Service Unavailable');
  });

  it('throws when the response body is empty', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '   ',
    } as Response);

    expect(fetchLatestCliVersion()).rejects.toThrow('Could not determine latest version');
  });

  it('throws when the network request fails', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));

    expect(fetchLatestCliVersion()).rejects.toThrow('network error');
  });
});

const INSTALL_SCRIPT_URL_SH = 'https://gist.githubusercontent.com/kirill-knize-sonarsource/663e7735f883c3b624575f27276a6b79/raw/b9e6add7371f16922a6a7a69d56822906b9e5758/install.sh';
const INSTALL_SCRIPT_URL_PS1 = 'https://gist.githubusercontent.com/kirill-knize-sonarsource/d75dd5f99228f5a67bcd11ec7d2ed295/raw/a5237e27b0c7bff9a5c7bdeec5fe4b112299b5d8/install.ps1';

describe('performSelfUpdate', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spawnSpy: any;

  afterEach(() => {
    fetchSpy?.mockRestore();
    spawnSpy?.mockRestore();
  });

  it('fetches the Unix install script and runs it with bash on non-Windows', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '#!/usr/bin/env bash\necho "done"',
    } as Response);
    spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: 'Installation complete.',
      stderr: '',
    });

    await expect(performSelfUpdate()).resolves.toBeUndefined();

    const [[fetchedUrl]] = fetchSpy.mock.calls;
    expect(fetchedUrl).toBe(INSTALL_SCRIPT_URL_SH);

    const [[interpreter]] = spawnSpy.mock.calls;
    expect(interpreter).toBe('bash');
  });

  it('throws when the install script fetch fails', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as Response);

    await expect(performSelfUpdate()).rejects.toThrow('Failed to fetch install script: 404 Not Found');
  });

  it('throws when the install script exits with a non-zero code', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '#!/usr/bin/env bash\nexit 1',
    } as Response);
    spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Download failed',
    });

    await expect(performSelfUpdate()).rejects.toThrow('Install script failed (exit 1): Download failed');
  });

  it('exposes the PowerShell install script URL constant', () => {
    expect(INSTALL_SCRIPT_URL_PS1).toContain('install.ps1');
  });
});
