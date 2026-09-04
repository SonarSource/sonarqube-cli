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

// `sonar auth login` must release stdin on failure, not only on success. The browser token step
// resumes it for Windows keypresses, and a resumed TTY stdin keeps the process alive, so the
// command would print its error and then hang.
//
// This is a unit test because the integration harness runs non-TTY: `process.stdin.isTTY` is
// false there, so the branch is unreachable.

// Everything is stubbed with `spyOn`, never `mock.module`: the coverage run
// (`bun test ./tests/unit/`, no `--parallel`) shares one process across files, and a module mock
// has no teardown, so it would leak into every later file.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { authLogin } from '@/commands/auth/login.ts';
import * as tokenModule from '@/core/auth/token.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { SONARCLOUD_URL } from '@/core/config-constants.ts';
import { SonarQubeClient } from '@/core/server/client.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';
import { createKeychainTestHandle } from '../../core/host/keychain-test-handle.ts';

let fake: FakeConsole;

beforeEach(() => {
  fake = new FakeConsole();
});

describe('authLogin stdin release', () => {
  let spies: ReturnType<typeof spyOn>[] = [];
  let pauseSpy: ReturnType<typeof spyOn>;
  let resolveAccessSpy: ReturnType<typeof spyOn>;
  let revokeSpy: ReturnType<typeof spyOn>;
  let generateTokenSpy: ReturnType<typeof spyOn>;
  const originalIsTTY = process.stdin.isTTY;
  const keychain = createKeychainTestHandle();

  beforeEach(() => {
    keychain.setup();
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    pauseSpy = spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
    revokeSpy = spyOn(SonarQubeClient.prototype, 'revokeUserToken').mockResolvedValue(undefined);
    resolveAccessSpy = spyOn(SonarQubeClient.prototype, 'resolveOrganizationAccess');
    generateTokenSpy = spyOn(tokenModule, 'generateTokenViaBrowser').mockResolvedValue({
      token: 'minted-token',
      tokenName: 'cli-browser-token',
    });
    spies = [pauseSpy, revokeSpy, resolveAccessSpy, generateTokenSpy];
  });

  afterEach(() => {
    keychain.teardown();
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  it('pauses stdin when the browser token step is cancelled', async () => {
    // Ctrl+C at "Waiting for authorization..." resumes stdin on its way out, so the token step
    // has to be inside the guarded region too.
    generateTokenSpy.mockRejectedValueOnce(new Error('Authentication cancelled'));

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(
      authLogin({ server: SONARCLOUD_URL, org: 'my-org' }, new CommandInvocationContext(fake)),
    ).rejects.toThrow('Authentication cancelled');

    expect(pauseSpy).toHaveBeenCalled();
  });

  it('pauses stdin when the organization is rejected', async () => {
    resolveAccessSpy.mockResolvedValue({ status: 'not_found' });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(
      authLogin(
        { server: SONARCLOUD_URL, org: 'nonexistent-org' },
        new CommandInvocationContext(fake),
      ),
    ).rejects.toThrow("Organization 'nonexistent-org' not found or not accessible.");

    expect(pauseSpy).toHaveBeenCalled();
  });

  it('pauses stdin when the organization lookup could not be completed', async () => {
    resolveAccessSpy.mockResolvedValue({ status: 'check_failed', reason: 'connection refused' });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(
      authLogin({ server: SONARCLOUD_URL, org: 'my-org' }, new CommandInvocationContext(fake)),
    ).rejects.toThrow("Could not verify organization 'my-org'");

    expect(pauseSpy).toHaveBeenCalled();
  });

  it('revokes the freshly minted token when the organization is rejected', async () => {
    resolveAccessSpy.mockResolvedValue({ status: 'not_found' });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(
      authLogin(
        { server: SONARCLOUD_URL, org: 'nonexistent-org' },
        new CommandInvocationContext(fake),
      ),
    ).rejects.toThrow();

    expect(revokeSpy).toHaveBeenCalledWith('cli-browser-token');
  });
});
