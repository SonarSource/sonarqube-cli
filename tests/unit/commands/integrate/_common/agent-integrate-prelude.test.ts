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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { displayAgentIntegratePrelude } from '@/commands/integrate/_common/agent-integrate-prelude.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import * as token from '@/core/auth/token.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';

const CLOUD_AUTH = new ResolvedAuth({
  token: 'token',
  serverUrl: 'https://sonarcloud.io',
  orgKey: 'my-org',
  connectionType: 'cloud',
  source: 'state' as const,
});

describe('displayAgentIntegratePrelude', () => {
  let fake: FakeConsole;
  let checkTokenStatusSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fake = new FakeConsole();
    checkTokenStatusSpy = spyOn(token, 'checkTokenStatus').mockResolvedValue({ status: 'valid' });
  });

  afterEach(() => {
    checkTokenStatusSpy.mockRestore();
  });

  it('prints only the intro when the token is valid', async () => {
    await displayAgentIntegratePrelude('Claude Code', CLOUD_AUTH, fake);

    expect(fake.calls.map((c) => c.method)).toEqual(['intro']);
  });

  it('throws when SonarQube Cloud has no organization', async () => {
    const auth = new ResolvedAuth({
      token: 'token',
      serverUrl: 'https://sonarcloud.io',
      connectionType: 'cloud',
      source: 'state' as const,
    });

    const error = await captureRejection(displayAgentIntegratePrelude('Claude Code', auth, fake));

    expect((error as Error).message).toBe('SonarQube Cloud requires an organization.');
    expect(checkTokenStatusSpy).not.toHaveBeenCalled();
  });

  it('rejects an invalid token with a login hint', async () => {
    checkTokenStatusSpy.mockResolvedValue({ status: 'invalid' });

    const error = await captureRejection(
      displayAgentIntegratePrelude('Claude Code', CLOUD_AUTH, fake),
    );

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as Error).message).toBe('Token is invalid.');
  });

  it('shows setup failed guidance when the server is unreachable', async () => {
    checkTokenStatusSpy.mockResolvedValue({ status: 'unreachable' });

    const error = await captureRejection(
      displayAgentIntegratePrelude('Claude Code', CLOUD_AUTH, fake),
    );

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as Error).message).toBe('Server is unreachable.');
    expect(
      fake.calls.find((c) => c.method === 'outro' && c.args[0] === 'Setup failed'),
    ).toBeDefined();
    expect(
      fake.calls.find(
        (c) => c.method === 'info' && String(c.args[0]).includes('Server could not be reached'),
      ),
    ).toBeDefined();
    expect(
      fake.calls.find((c) => c.method === 'text' && String(c.args[0]).includes('SONAR_HOST_URL')),
    ).toBeDefined();
  });
});

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected promise to reject');
}
