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

// A rejected organization key must not throw away the browser flow the user just completed, so the
// login offers another way in instead of aborting: on a terminal a typo or an empty line asks
// again, and a stale key in the project config falls back to the user's memberships.
//
// Re-prompting is unit-tested because it only happens on a TTY, and the integration harness runs
// non-TTY: piped input has nobody to ask, so there the first rejection still aborts. The config
// fallback asks nothing, so its non-TTY behaviour is covered in the integration spec instead.

// Everything is stubbed with `spyOn`, never `mock.module`: the coverage run
// (`bun test ./tests/unit/`, no `--parallel`) shares one process across files, and a module mock
// has no teardown, so it would leak into every later file.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { authLogin } from '@/commands/auth/login.ts';
import * as tokenModule from '@/core/auth/token.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { SONARCLOUD_URL } from '@/core/config-constants.ts';
import * as projectInfo from '@/core/project-info.ts';
import { SonarQubeClient } from '@/core/server/client.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';
import { createKeychainTestHandle } from '../../core/host/keychain-test-handle.ts';

/** Every prompt the login made, in order. */
function textPrompts(): unknown[][] {
  return fake.calls.filter((call) => call.method === 'textPrompt').map((call) => call.args);
}

let fake: FakeConsole;

describe('authLogin organization prompt', () => {
  let spies: ReturnType<typeof spyOn>[] = [];
  let resolveAccessSpy: ReturnType<typeof spyOn>;
  let discoverOrgSpy: ReturnType<typeof spyOn>;
  let listOrgsSpy: ReturnType<typeof spyOn>;
  let revokeSpy: ReturnType<typeof spyOn>;
  let userHome = '';
  const originalUserHome = process.env.SONAR_USER_HOME;
  const originalIsTTY = process.stdin.isTTY;
  const keychain = createKeychainTestHandle();

  beforeEach(() => {
    fake = new FakeConsole();
    keychain.setup();
    // A login that succeeds persists a connection; without this it would land in the real
    // ~/.sonar, whose queued events a later genuine `sonar` command would pick up and send.
    userHome = mkdtempSync(join(tmpdir(), 'sonar-login-org-'));
    process.env.SONAR_USER_HOME = userHome;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    resolveAccessSpy = spyOn(SonarQubeClient.prototype, 'resolveOrganizationAccess');
    listOrgsSpy = spyOn(SonarQubeClient.prototype, 'listUserOrganizations').mockResolvedValue({
      organizations: [],
      total: 0,
    });
    // This repository has its own sonar-project.properties; without these the discovered key
    // would short-circuit the prompt under test.
    discoverOrgSpy = spyOn(projectInfo, 'discoverOrganization').mockResolvedValue(null);
    revokeSpy = spyOn(SonarQubeClient.prototype, 'revokeUserToken').mockResolvedValue(undefined);
    spies = [
      spyOn(process.stdin, 'pause').mockReturnValue(process.stdin),
      revokeSpy,
      spyOn(tokenModule, 'generateTokenViaBrowser').mockResolvedValue({
        token: 'minted-token',
        tokenName: 'cli-browser-token',
      }),
      spyOn(projectInfo, 'discoverServer').mockResolvedValue(null),
      discoverOrgSpy,
      listOrgsSpy,
      resolveAccessSpy,
    ];
  });

  afterEach(() => {
    keychain.teardown();
    if (originalUserHome === undefined) {
      delete process.env.SONAR_USER_HOME;
    } else {
      process.env.SONAR_USER_HOME = originalUserHome;
    }
    rmSync(userHome, { force: true, recursive: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  it('asks again when the typed organization does not exist', async () => {
    fake.queueResponse('typo-org');
    fake.queueResponse('unreachable-org');
    resolveAccessSpy
      .mockResolvedValueOnce({ status: 'not_found' })
      .mockResolvedValueOnce({ status: 'check_failed', reason: 'connection refused' });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(
      authLogin({ server: SONARCLOUD_URL }, new CommandInvocationContext(fake)),
    ).rejects.toThrow("Could not verify organization 'unreachable-org'");

    expect(textPrompts()).toHaveLength(2);
  });

  it('completes the login on the second key and keeps the minted token', async () => {
    fake.queueResponse('typo-org');
    fake.queueResponse('my-org');
    resolveAccessSpy
      .mockResolvedValueOnce({ status: 'not_found' })
      .mockResolvedValueOnce({ status: 'accessible' });

    await authLogin({ server: SONARCLOUD_URL }, new CommandInvocationContext(fake));

    expect(textPrompts()).toHaveLength(2);
    // The whole point of asking again: the browser flow the user just went through is not wasted.
    expect(revokeSpy).not.toHaveBeenCalled();
    expect(fake.findCall('success', 'Authentication successful')).toBeDefined();
  });

  it('gives up after a bounded number of unusable answers', async () => {
    // The mocked prompt answers with an empty string once its queue is drained, so an unbounded
    // loop would spin here until the test timed out instead of reporting a failure.
    resolveAccessSpy.mockResolvedValue({ status: 'not_found' });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(
      authLogin({ server: SONARCLOUD_URL }, new CommandInvocationContext(fake)),
    ).rejects.toThrow('Organization key is required.');

    expect(textPrompts()).toHaveLength(5);
  });

  it('asks again when the answer is empty', async () => {
    fake.queueResponse('');
    fake.queueResponse('unreachable-org');
    resolveAccessSpy.mockResolvedValue({ status: 'check_failed', reason: 'connection refused' });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(
      authLogin({ server: SONARCLOUD_URL }, new CommandInvocationContext(fake)),
    ).rejects.toThrow("Could not verify organization 'unreachable-org'");

    expect(textPrompts()).toHaveLength(2);
    expect(fake.findCall('warn', 'Organization key is required.')).toBeDefined();
  });

  it('falls back to the organization list when the project config key does not exist', async () => {
    discoverOrgSpy.mockResolvedValue('stale-org');
    fake.queueResponse('unreachable-org');
    resolveAccessSpy
      .mockResolvedValueOnce({ status: 'not_found' })
      .mockResolvedValueOnce({ status: 'check_failed', reason: 'connection refused' });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(
      authLogin({ server: SONARCLOUD_URL }, new CommandInvocationContext(fake)),
    ).rejects.toThrow("Could not verify organization 'unreachable-org'");

    expect(fake.findCall('warn', "'stale-org' from project config")).toBeDefined();
    expect(listOrgsSpy).toHaveBeenCalled();
    expect(textPrompts()).toHaveLength(1);
  });

  it('aborts when the project config key could not be looked up', async () => {
    discoverOrgSpy.mockResolvedValue('stale-org');
    resolveAccessSpy.mockResolvedValue({ status: 'check_failed', reason: 'connection refused' });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(
      authLogin({ server: SONARCLOUD_URL }, new CommandInvocationContext(fake)),
    ).rejects.toThrow("Could not verify organization 'stale-org'");

    expect(listOrgsSpy).not.toHaveBeenCalled();
    expect(textPrompts()).toHaveLength(0);
  });

  it('aborts on the first rejection when stdin is not a terminal', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    fake.queueResponse('typo-org');
    resolveAccessSpy.mockResolvedValue({ status: 'not_found' });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(
      authLogin({ server: SONARCLOUD_URL }, new CommandInvocationContext(fake)),
    ).rejects.toThrow("Organization 'typo-org' not found or not accessible.");

    expect(textPrompts()).toHaveLength(1);
  });
});
