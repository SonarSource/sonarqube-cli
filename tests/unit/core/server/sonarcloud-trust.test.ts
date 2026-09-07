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

import { confirmServerTrust } from '@/commands/auth/login.ts';
import { isTrustedSonarQubeCloudUrl } from '@/core/server/sonarcloud-region.ts';
import type { Console } from '@/core/ui/console.ts';

describe('isTrustedSonarQubeCloudUrl', () => {
  it('is true for the real SonarQube Cloud hosts', () => {
    expect(isTrustedSonarQubeCloudUrl('https://sonarcloud.io')).toBe(true);
    expect(isTrustedSonarQubeCloudUrl('https://sonarqube.us')).toBe(true);
  });

  it('is false for a non-SonarSource host', () => {
    expect(isTrustedSonarQubeCloudUrl('https://not-sonarcloud.example.com')).toBe(false);
  });
});

describe('confirmServerTrust', () => {
  it('prompts for confirmation when the server is not a real Cloud host', async () => {
    let promptCount = 0;
    const console = {
      warn: () => {},
      confirmPrompt: async () => {
        promptCount += 1;
        return true;
      },
    } as unknown as Console;

    await confirmServerTrust('https://not-sonarcloud.example.com', console);

    expect(promptCount).toBe(1);
  });

  it('does not prompt for the real SonarQube Cloud host', async () => {
    let promptCount = 0;
    const console = {
      warn: () => {},
      confirmPrompt: async () => {
        promptCount += 1;
        return true;
      },
    } as unknown as Console;

    await confirmServerTrust('https://sonarcloud.io', console);

    expect(promptCount).toBe(0);
  });
});
