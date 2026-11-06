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

import { describe, expect, it } from 'bun:test';

import { confirmServerTrust } from '@/commands/auth/select-server.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { SONARCLOUD_URL } from '@/core/config-constants.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

describe('confirmServerTrust', () => {
  it('cancels a self-hosted login when the confirmation keeps its default', async () => {
    const console = new FakeConsole();

    const error = await confirmServerTrust('https://sonarqube.example.com', console).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as CommandFailedError).message).toBe('Login cancelled');
    expect(console.findCall('warn', 'Only connect to servers you trust.')).toBeDefined();
    expect(
      console.findCall('confirmPrompt', 'Connect to: https://sonarqube.example.com?')?.args[1],
    ).toBe(false);
  });

  it('continues when the user confirms the self-hosted server', async () => {
    const console = new FakeConsole();
    console.queueResponse(true);

    await confirmServerTrust('https://sonarqube.example.com', console);

    expect(
      console.findCall('confirmPrompt', 'Connect to: https://sonarqube.example.com?')?.args[1],
    ).toBe(true);
  });

  it('skips the confirmation for SonarQube Cloud', async () => {
    const console = new FakeConsole();

    await confirmServerTrust(SONARCLOUD_URL, console);

    expect(console.calls).toHaveLength(0);
  });
});
