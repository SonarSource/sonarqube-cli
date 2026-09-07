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

// Unit tests for `sonar link`, mocking SharedProjectConfigRepository and git-root
// resolution instead of touching a real repository (covered end-to-end by the
// integration spec at tests/integration/specs/link/link.test.ts).

import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import * as gitWorktree from '@/core/host/git/worktree.ts';
import { sharedProjectConfigRepository } from '@/core/shared-project-config.ts';

import { link, type LinkOptions } from '../../../../src/commands/link/index.ts';
import { FakeConsole } from '../../../_common/fake-console.ts';

const onPremAuth: ResolvedAuth = {
  token: 'test-token',
  serverUrl: 'https://sonarqube.example.com',
  connectionType: 'on-premise',
};

const cloudAuth: ResolvedAuth = {
  token: 'test-token',
  serverUrl: 'https://sonarcloud.io',
  orgKey: 'my-org',
  connectionType: 'cloud',
};

describe('link', () => {
  let fake: FakeConsole;
  let gitRootSpy: Mock<typeof gitWorktree.resolveGitRepoRoot>;
  let setSpy: Mock<typeof sharedProjectConfigRepository.set>;

  function ctxFor(auth: ResolvedAuth): CommandAuthenticatedInvocationContext {
    return new CommandAuthenticatedInvocationContext(auth, fake);
  }

  beforeEach(() => {
    fake = new FakeConsole();
    // process.cwd() always exists, so it doubles as a real target directory
    // without needing to create one on disk for these tests.
    gitRootSpy = spyOn(gitWorktree, 'resolveGitRepoRoot').mockResolvedValue(process.cwd());
    setSpy = spyOn(sharedProjectConfigRepository, 'set').mockResolvedValue(undefined);
  });

  afterEach(() => {
    gitRootSpy.mockRestore();
    setSpy.mockRestore();
  });

  it('writes a Server entry derived from an on-premise connection', async () => {
    await link('my_project', { path: '.' }, ctxFor(onPremAuth));

    expect(setSpy).toHaveBeenCalledWith(process.cwd(), {
      projectKey: 'my_project',
      path: '.',
      serverUrl: onPremAuth.serverUrl,
    });
  });

  it('writes a Cloud entry derived from a Cloud connection', async () => {
    await link('my_project', { path: '.' }, ctxFor(cloudAuth));

    expect(setSpy).toHaveBeenCalledWith(process.cwd(), {
      projectKey: 'my_project',
      path: '.',
      region: 'eu',
      organization: 'my-org',
    });
  });

  it('fails without writing when the Cloud connection has no resolvable region', async () => {
    const auth: ResolvedAuth = { ...cloudAuth, serverUrl: 'https://custom-cloud.example.com' };

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(link('my_project', { path: '.' }, ctxFor(auth))).rejects.toThrow('region');
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('rejects a blank --path without resolving git or writing anything', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(link('my_project', { path: ' ' }, ctxFor(onPremAuth))).rejects.toThrow(
      '--path must not be empty.',
    );
    expect(gitRootSpy).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('rejects a --path that does not resolve to an existing directory, without writing', async () => {
    const options: LinkOptions = { path: 'this-directory-does-not-exist' };

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(link('my_project', options, ctxFor(onPremAuth))).rejects.toThrow(
      'must point to an existing directory inside',
    );
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('warns and writes to the current directory when no git repository is found', async () => {
    gitRootSpy.mockResolvedValue(null);

    await link('my_project', { path: '.' }, ctxFor(onPremAuth));

    expect(setSpy).toHaveBeenCalledWith(process.cwd(), expect.anything());
    const warnings = fake.calls.filter((c) => c.method === 'warn');
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0].args[0])).toContain('No git repository found');
  });

  it('does not warn about a missing git repository when one is found', async () => {
    await link('my_project', { path: '.' }, ctxFor(onPremAuth));

    expect(fake.calls.filter((c) => c.method === 'warn')).toHaveLength(0);
  });
});
