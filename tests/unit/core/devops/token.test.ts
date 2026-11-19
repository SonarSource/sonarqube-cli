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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { resolveDevOpsToken } from '@/core/devops/token.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

describe.each(['GitLab', 'GitHub'] as const)('resolveDevOpsToken(%s)', (platform) => {
  const envName = `${platform.toUpperCase()}_TOKEN`;
  let previousToken: string | undefined;
  let console: FakeConsole;

  beforeEach(() => {
    previousToken = process.env[envName];
    delete process.env[envName];
    console = new FakeConsole();
  });

  afterEach(() => {
    if (previousToken === undefined) delete process.env[envName];
    else process.env[envName] = previousToken;
  });

  it('reads the provider environment token without prompting in noninteractive mode', async () => {
    process.env[envName] = 'environment-token';
    console.setCanPrompt(false);
    expect(await resolveDevOpsToken(console, platform)).toBe('environment-token');
    expect(console.calls).toHaveLength(0);
  });

  it('allows a hidden prompt to override the environment token', async () => {
    process.env[envName] = 'environment-token';
    console.queueResponse('prompted-token');
    expect(await resolveDevOpsToken(console, platform)).toBe('prompted-token');
    const prompt = console.findCall('passwordPrompt', `${platform} personal access token`);
    expect(prompt?.args[0]).toBe(
      `${platform} personal access token (press Enter to use ${envName}):`,
    );
    expect(prompt?.args[0]).not.toContain('environment-token');
  });

  it('uses the environment token when Enter is pressed', async () => {
    process.env[envName] = 'environment-token';
    console.queueResponse('');
    expect(await resolveDevOpsToken(console, platform)).toBe('environment-token');
  });

  it('accepts a prompted token without an environment token', async () => {
    console.queueResponse('prompted-token');
    expect(await resolveDevOpsToken(console, platform)).toBe('prompted-token');
  });

  it('honors cancellation even when an environment token is available', async () => {
    process.env[envName] = 'environment-token';
    console.queueResponse(null);
    const error = await resolveDevOpsToken(console, platform).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as Error).message).toBe(`${platform} token is required.`);
  });

  it('reports a missing token without prompting noninteractive callers', async () => {
    console.setCanPrompt(false);
    const error = await resolveDevOpsToken(console, platform).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as Error).message).toBe(
      `${platform} token required: set the ${envName} environment variable.`,
    );
    expect(console.calls).toHaveLength(0);
  });

  it('reports an empty prompt without an environment fallback', async () => {
    console.queueResponse('');
    const error = await resolveDevOpsToken(console, platform).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as Error).message).toContain(`provide one at the prompt or set the ${envName}`);
  });
});
