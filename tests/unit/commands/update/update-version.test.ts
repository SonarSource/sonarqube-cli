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

import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { clearNetworkConfigCache } from '@/core/host/connectivity/network-config.ts';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '@/core/ui';
import { TerminalConsole } from '@/core/ui/terminal-console.ts';

function updateCtx(): CommandInvocationContext {
  return new CommandInvocationContext(new TerminalConsole());
}

// Spy on the real node:child_process / platform-detector modules rather than
// mock.module()-ing them: mock.module() swaps the module in the global registry for the
// rest of the test process (not just this file), so any later file that also imports
// node:child_process observes these test doubles instead of the real functions. spyOn
// mutates a property on the one real, shared module object and is restored per test.
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

const spawnMock = spyOn(childProcess, 'spawn').mockImplementation((() =>
  createSpawnChild()) as unknown as typeof childProcess.spawn);
const spawnSyncMock = spyOn(childProcess, 'spawnSync').mockImplementation(
  (() => ({ status: 0 }) as MockSpawnSyncResult) as unknown as typeof childProcess.spawnSync,
);

// Both Unix and Windows branches must be reachable on any OS, hence the spy.
const platformDetector = await import('@/core/host/environment/platform-detector.ts');
const isWindowsMock = spyOn(platformDetector, 'isWindows').mockImplementation(() => false);

const { checkForUpdate } = await import('@/commands/update/update-check.ts');
const { fetchLatestVersion } = await import('@/core/update/check.ts');
const { updateVersion } = await import('@/commands/update');

afterAll(() => {
  spawnMock.mockRestore();
  spawnSyncMock.mockRestore();
  isWindowsMock.mockRestore();
});

function stableVersionResponse(version: string) {
  return {
    ok: true,
    text: async () => Promise.resolve(`${version}\n`),
  };
}

describe('checkForUpdate', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns the latest update and marks upToDate false when stable.version is newer', async () => {
    fetchSpy.mockResolvedValue(stableVersionResponse('99.0.0.241'));

    const result = await checkForUpdate();

    expect(result.latest.version.text).toBe('99.0.0.241');
    expect(result.latest.version.noBuild.text).toBe('99.0.0');
    expect(String(result.currentVersion)).toBe((await import('../../../../package.json')).version);
    expect(result.upToDate).toBe(false);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('stable.version');
  });

  it('returns the latest update and marks upToDate true when the current version matches', async () => {
    // Same major.minor.patch as current; build number must be ignored.
    const [major, minor, patch] = (await import('../../../../package.json')).version.split('.');
    fetchSpy.mockResolvedValue(stableVersionResponse(`${major}.${minor}.${patch}.999`));

    const result = await checkForUpdate();

    expect(result.latest.version.text).toBe(`${major}.${minor}.${patch}.999`);
    expect(result.latest.version.noBuild.text).toBe(`${major}.${minor}.${patch}`);
    expect(result.upToDate).toBe(true);
  });

  it('reads the version from stable.version', async () => {
    fetchSpy.mockResolvedValue(stableVersionResponse('88.1.2.300'));

    const result = await fetchLatestVersion();

    expect(result).toBe('88.1.2.300');
  });

  it('uses the default 5s fetch timeout for self-update checks', async () => {
    const timeoutSpy = spyOn(AbortSignal, 'timeout');
    fetchSpy.mockResolvedValue(stableVersionResponse('88.1.2.300'));

    await fetchLatestVersion();

    expect(timeoutSpy).toHaveBeenCalledWith(5000);
    timeoutSpy.mockRestore();
  });

  it('accepts a custom fetch timeout', async () => {
    const timeoutSpy = spyOn(AbortSignal, 'timeout');
    fetchSpy.mockResolvedValue(stableVersionResponse('88.1.2.300'));

    await fetchLatestVersion(1500);

    expect(timeoutSpy).toHaveBeenCalledWith(1500);
    timeoutSpy.mockRestore();
  });

  it('throws on HTTP error', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 404 });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(checkForUpdate()).rejects.toThrow('HTTP 404');
  });

  it('throws when stable.version is invalid', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => Promise.resolve('not-a-version'),
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(checkForUpdate()).rejects.toThrow('Could not determine the latest version');
  });

  describe('with SONAR_HTTPS_PROXY_URL set', () => {
    let originalProxyUrl: string | undefined;

    beforeEach(() => {
      originalProxyUrl = process.env.SONAR_HTTPS_PROXY_URL;
      process.env.SONAR_HTTPS_PROXY_URL = 'http://proxy.corp.com:3128';
      clearNetworkConfigCache();
    });

    afterEach(() => {
      if (originalProxyUrl === undefined) {
        delete process.env.SONAR_HTTPS_PROXY_URL;
      } else {
        process.env.SONAR_HTTPS_PROXY_URL = originalProxyUrl;
      }
      clearNetworkConfigCache();
    });

    it('passes proxy option to fetch', async () => {
      fetchSpy.mockResolvedValue(stableVersionResponse('1.0.0'));

      await checkForUpdate();

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ proxy: 'http://proxy.corp.com:3128' }),
      );
    });
  });
});

describe('updateVersion --status', () => {
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
    fetchSpy.mockResolvedValue(stableVersionResponse('99.0.0.241'));

    await updateVersion({ status: true }, updateCtx());

    const messages = getMockUiCalls().map((c) => c.args.join(' '));
    // Build number must be stripped from displayed versions
    expect(messages.some((m) => m.includes('99.0.0') && !m.includes('99.0.0.241'))).toBe(true);
    expect(messages.some((m) => /update available/i.test(m))).toBe(true);
  });

  it('reports already up to date', async () => {
    fetchSpy.mockResolvedValue(stableVersionResponse('0.0.1'));

    await updateVersion({ status: true }, updateCtx());

    const messages = getMockUiCalls().map((c) => c.args.join(' '));
    expect(messages.some((m) => /up to date/i.test(m))).toBe(true);
  });
});

describe('updateVersion (no options)', () => {
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

  it('reports already up to date and does not attempt to install', async () => {
    const [major, minor, patch] = (await import('../../../../package.json')).version.split('.');
    fetchSpy.mockResolvedValue(stableVersionResponse(`${major}.${minor}.${patch}.999`));

    await updateVersion({}, updateCtx());

    const messages = getMockUiCalls().map((c) => c.args.join(' '));
    expect(messages.some((m) => /already up to date/i.test(m))).toBe(true);
    // Only the stable.version check should run; the install script must not be fetched.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('updateVersion --force', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    spawnMock.mockClear();
    spawnMock.mockImplementation((() =>
      createSpawnChild()) as unknown as typeof childProcess.spawn);
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
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).endsWith('stable.version')) {
        return Promise.resolve(stableVersionResponse(latestVersion));
      }
      if (String(url).includes('install.')) {
        return Promise.resolve({
          ok: true,
          text: async () => Promise.resolve(scriptContent),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    await updateVersion({ force: true }, updateCtx());
  }

  it('installs even when already up to date', async () => {
    const [major, minor, patch] = (await import('../../../../package.json')).version.split('.');
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
    spawnSyncMock.mockReturnValue({
      status: 12,
    } as unknown as ReturnType<typeof childProcess.spawnSync>);

    try {
      await runForce('2.0.0');
      throw new Error('Expected updateVersion to fail');
    } catch (error) {
      expect((error as Error).message).toContain('Update script exited with code 12');
    }
  });

  it('throws the underlying spawn error when the update script cannot be started', async () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      error: new Error('spawnSync /bin/bash ENOENT'),
    } as unknown as ReturnType<typeof childProcess.spawnSync>);

    try {
      await runForce('2.0.0');
      throw new Error('Expected updateVersion to fail');
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
    spawnMock.mockImplementation((() =>
      createSpawnChild('error', 'spawn cmd.exe ENOENT')) as unknown as typeof childProcess.spawn);

    try {
      await runForce('2.0.0', 'Write-Host hi\n');
      throw new Error('Expected updateVersion to fail');
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
