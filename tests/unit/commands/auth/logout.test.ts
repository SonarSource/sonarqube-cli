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

import { expect, it, spyOn } from 'bun:test';

import { authLogout } from '@/commands/auth/logout.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import * as keychain from '@/core/host/keychain.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

it.each([
  { concurrentChange: 'removed', newerConnectionKept: false },
  { concurrentChange: 'newer login', newerConnectionKept: true },
] as const)(
  'logout after a concurrent $concurrentChange',
  async ({ concurrentChange, newerConnectionKept }) => {
    const snapshot = getDefaultState('1.0.0');
    const active = {
      id: 'connection-id',
      type: 'on-premise' as const,
      serverUrl: 'https://sonarqube.example',
      authenticatedAt: '2026-01-01T00:00:00.000Z',
    };
    snapshot.auth.isAuthenticated = true;
    snapshot.auth.activeConnectionId = active.id;
    snapshot.auth.connections = [active];

    const latest = structuredClone(snapshot);
    if (concurrentChange === 'removed') {
      latest.auth.isAuthenticated = false;
      latest.auth.activeConnectionId = undefined;
      latest.auth.connections = [];
    } else {
      latest.auth.connections[0].authenticatedAt = '2026-01-02T00:00:00.000Z';
    }

    const loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(snapshot);
    const updateStateSpy = spyOn(stateRepository, 'updateState').mockImplementation((update) =>
      update(latest),
    );
    const getTokenSpy = spyOn(keychain, 'getToken').mockResolvedValue(null);
    const deleteTokenSpy = spyOn(keychain, 'deleteToken').mockResolvedValue(undefined);

    try {
      const console = new FakeConsole();
      await authLogout(new CommandInvocationContext(console));

      expect(
        console.findCall('warn', 'The newer connection was kept in state.') !== undefined,
      ).toBe(newerConnectionKept);
      expect(console.findCall('success', 'Logged out from:') !== undefined).toBe(
        !newerConnectionKept,
      );
      expect(latest.auth.connections).toHaveLength(newerConnectionKept ? 1 : 0);
    } finally {
      loadStateSpy.mockRestore();
      updateStateSpy.mockRestore();
      getTokenSpy.mockRestore();
      deleteTokenSpy.mockRestore();
    }
  },
);
