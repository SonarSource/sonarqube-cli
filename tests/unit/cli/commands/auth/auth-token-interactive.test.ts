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

// Tests for waitForTokenInteractive: server delivery path, user input path,
// printed messages, and readline close (releases stdin so next prompt works on Windows).

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

// ─── readline mock ───────────────────────────────────────────────────────────
// Control question callback and close event so we can drive the flow without a real TTY.

let questionCallback: ((line: string) => void) | null = null;
let closeHandler: (() => void) | null = null;
let closeCalled = false;

const rlMock = {
  question(_prompt: string, cb: (line: string) => void) {
    questionCallback = cb;
  },
  close() {
    closeCalled = true;
    closeHandler?.();
  },
  on(ev: string, cb: () => void) {
    if (ev === 'close') closeHandler = cb;
  },
  simulateCtrlC() {
    closeHandler?.();
  },
};

// eslint-disable-next-line @typescript-eslint/no-floating-promises
mock.module('node:readline', () => ({
  createInterface: () => rlMock,
}));

const mockOpenBrowser = mock((_url: string) => Promise.resolve());
// eslint-disable-next-line @typescript-eslint/no-floating-promises
mock.module('../../../../../src/lib/browser.js', () => ({
  openBrowser: mockOpenBrowser,
}));

import {
  type BrowserAuthResult,
  openBrowserWithFallback,
  waitForTokenInteractive,
} from '../../../../../src/cli/commands/_common/token';

// ─── Shared setup ─────────────────────────────────────────────────────────────

function makeSharedSpies() {
  const writeSpy = spyOn(process.stdout, 'write').mockReturnValue(true);
  return { writeSpy };
}

function restoreSharedSpies(spies: ReturnType<typeof makeSharedSpies>) {
  spies.writeSpy.mockRestore();
}

function resetMockState() {
  questionCallback = null;
  closeHandler = null;
  closeCalled = false;
}

// ─── Printed messages ─────────────────────────────────────────────────────────

describe('waitForTokenInteractive: printed messages', () => {
  let spies: ReturnType<typeof makeSharedSpies>;

  beforeEach(() => {
    resetMockState();
    spies = makeSharedSpies();
  });
  afterEach(() => {
    restoreSharedSpies(spies);
  });

  it('prints the waiting message when started', async () => {
    const p = waitForTokenInteractive(new Promise<BrowserAuthResult>(() => {}));
    await Promise.resolve();
    const out = spies.writeSpy.mock.calls.map((c) => (c[0] as string).toString()).join('');
    expect(out).toContain('Waiting for authorization');
    expect(out).toContain('paste token and press Enter');
    questionCallback?.('dummy');
    await p;
  });
});

// ─── Server delivery path ─────────────────────────────────────────────────────

describe('waitForTokenInteractive: server delivers token', () => {
  let spies: ReturnType<typeof makeSharedSpies>;

  beforeEach(() => {
    resetMockState();
    spies = makeSharedSpies();
  });
  afterEach(() => {
    restoreSharedSpies(spies);
  });

  it('resolves with the server token', async () => {
    const result = await waitForTokenInteractive(Promise.resolve({ token: 'squ_server_abc' }));
    expect(result).toEqual({ token: 'squ_server_abc' });
  });

  it('closes readline when server delivers (releases stdin for next prompt on Windows)', async () => {
    await waitForTokenInteractive(Promise.resolve({ token: 'squ_server_abc' }));
    expect(closeCalled).toBe(true);
  });

  it('ignores server token when user already submitted (settled flag)', async () => {
    let resolveServer!: (token: BrowserAuthResult) => void;
    const serverPromise = new Promise<BrowserAuthResult>((r) => {
      resolveServer = r;
    });
    const resultPromise = waitForTokenInteractive(serverPromise);
    await Promise.resolve();

    questionCallback?.('squ_user_token');
    await Promise.resolve();

    resolveServer({ token: 'squ_server_token' });
    expect(await resultPromise).toEqual({ token: 'squ_user_token' });
  });
});

// ─── User input path ──────────────────────────────────────────────────────────

describe('waitForTokenInteractive: user input', () => {
  let spies: ReturnType<typeof makeSharedSpies>;

  beforeEach(() => {
    resetMockState();
    spies = makeSharedSpies();
  });
  afterEach(() => {
    restoreSharedSpies(spies);
  });

  it('resolves with the user-entered token', async () => {
    const resultPromise = waitForTokenInteractive(new Promise<BrowserAuthResult>(() => {}));
    await Promise.resolve();
    questionCallback?.('squ_user_abc');
    expect(await resultPromise).toEqual({ token: 'squ_user_abc' });
  });

  it('trims whitespace from the user-entered token', async () => {
    const resultPromise = waitForTokenInteractive(new Promise<BrowserAuthResult>(() => {}));
    await Promise.resolve();
    questionCallback?.('  squ_padded  ');
    expect(await resultPromise).toEqual({ token: 'squ_padded' });
  });

  it('rejects when the user cancels (Ctrl+C)', async () => {
    const resultPromise = waitForTokenInteractive(new Promise<BrowserAuthResult>(() => {}));
    await Promise.resolve();
    rlMock.simulateCtrlC();
    expect(resultPromise).rejects.toThrow('Authentication cancelled');
  });

  it('closes readline when user submits', async () => {
    const resultPromise = waitForTokenInteractive(new Promise<BrowserAuthResult>(() => {}));
    await Promise.resolve();
    questionCallback?.('squ_user_abc');
    await resultPromise;
    expect(closeCalled).toBe(true);
  });

  it('ignores empty submission and keeps waiting', async () => {
    let resolveServer!: (token: BrowserAuthResult) => void;
    const serverPromise = new Promise<BrowserAuthResult>((r) => {
      resolveServer = r;
    });
    const resultPromise = waitForTokenInteractive(serverPromise);
    await Promise.resolve();

    questionCallback?.('');
    await Promise.resolve();

    resolveServer({ token: 'squ_server_fallback' });
    expect(await resultPromise).toEqual({ token: 'squ_server_fallback' });
  });
});

// ─── openBrowserWithFallback ──────────────────────────────────────────────────

describe('openBrowserWithFallback', () => {
  let savedCI: string | undefined;

  beforeEach(() => {
    mockOpenBrowser.mockClear();
    savedCI = process.env['CI'];
    delete process.env['CI'];
  });

  afterEach(() => {
    if (savedCI !== undefined) {
      process.env['CI'] = savedCI;
    }
  });

  it('calls openBrowser with the auth URL', async () => {
    await openBrowserWithFallback('https://sonarcloud.io/test');
    expect(mockOpenBrowser).toHaveBeenCalledWith('https://sonarcloud.io/test');
  });

  it('does not throw when browser opening fails', () => {
    mockOpenBrowser.mockImplementationOnce(() => Promise.reject(new Error('No browser found')));
    expect(openBrowserWithFallback('https://sonarcloud.io/test')).resolves.toBeUndefined();
  });

  it('skips browser when CI=true', async () => {
    process.env['CI'] = 'true';
    try {
      await openBrowserWithFallback('https://sonarcloud.io/test');
      expect(mockOpenBrowser).not.toHaveBeenCalled();
    } finally {
      delete process.env['CI'];
    }
  });
});
