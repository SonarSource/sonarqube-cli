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
import * as serverToken from '@/commands/auth/revoke-server-token.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import * as keychain from '@/core/host/keychain.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

it.each([true, false])(
  'skips revocation for a conflicting connection with scoped=%s',
  async (scoped) => {
    const snapshot = getDefaultState('1.0.0');
    const selected = {
      id: 'selected',
      type: 'on-premise' as const,
      serverUrl: 'http://sample.example.test:9000/current',
      tokenName: 'fixture-token-name',
      authenticatedAt: '2026-01-01T00:00:00.000Z',
    };
    snapshot.auth = {
      isAuthenticated: true,
      activeConnectionId: scoped ? 'unrelated' : selected.id,
      connections: [
        { ...selected, id: 'unrelated', serverUrl: 'https://unrelated.example.test' },
        selected,
        { ...selected, id: 'sibling', serverUrl: 'https://sample.example.test:9443/other' },
      ],
    };
    const latest = structuredClone(snapshot);
    const loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(snapshot);
    const updateStateSpy = spyOn(stateRepository, 'updateState').mockImplementation((update) =>
      update(latest),
    );
    const getTokenSpy = spyOn(keychain, 'getToken').mockResolvedValue('fixture-token');
    const revokeTokenSpy = spyOn(serverToken, 'revokeServerTokenIfPossible').mockResolvedValue({
      status: 'success',
    });
    const deleteTokenSpy = spyOn(keychain, 'deleteToken').mockResolvedValue(undefined);
    try {
      const console = new FakeConsole();
      await authLogout(
        new CommandInvocationContext(console),
        scoped ? { server: selected.serverUrl } : {},
      );
      expect(getTokenSpy).not.toHaveBeenCalled();
      expect(revokeTokenSpy).not.toHaveBeenCalled();
      expect(deleteTokenSpy.mock.calls).toEqual([[selected.serverUrl]]);
      expect(console.calls.filter((call) => call.method === 'warn')).toEqual([
        {
          method: 'warn',
          args: [
            'The server-side token could not be revoked automatically. Revoke it manually on the server if needed. Continuing with local logout.',
          ],
        },
      ]);
      expect(latest.auth.connections.map((connection) => connection.id)).toEqual(
        scoped ? ['unrelated'] : ['unrelated', 'sibling'],
      );
      expect(latest.auth.activeConnectionId).toBe(scoped ? 'unrelated' : undefined);
      expect(latest.auth.isAuthenticated).toBe(scoped);
    } finally {
      loadStateSpy.mockRestore();
      updateStateSpy.mockRestore();
      getTokenSpy.mockRestore();
      revokeTokenSpy.mockRestore();
      deleteTokenSpy.mockRestore();
    }
  },
);

it.each(['https', 'http'])('retains revocation for a compatible %s connection', async (scheme) => {
  const state = getDefaultState('1.0.0');
  const selected = {
    id: 'selected',
    type: 'on-premise' as const,
    serverUrl: `${scheme}://sample.example.test`,
    tokenName: 'fixture-token-name',
    authenticatedAt: '2026-01-01T00:00:00.000Z',
  };
  state.auth = {
    isAuthenticated: true,
    activeConnectionId: selected.id,
    connections: [selected],
  };
  const spies = [
    spyOn(stateRepository, 'loadState').mockReturnValue(structuredClone(state)),
    spyOn(stateRepository, 'updateState').mockImplementation((update) => update(state)),
    spyOn(keychain, 'getToken').mockResolvedValue('fixture-token'),
    spyOn(serverToken, 'revokeServerTokenIfPossible').mockResolvedValue({ status: 'success' }),
    spyOn(keychain, 'deleteToken').mockResolvedValue(undefined),
  ];
  try {
    const console = new FakeConsole();
    await authLogout(new CommandInvocationContext(console));
    expect(spies[2].mock.calls).toEqual([[selected.serverUrl]]);
    expect(spies[3].mock.calls).toEqual([[selected, 'fixture-token']]);
    expect(spies[4].mock.calls).toEqual([[selected.serverUrl]]);
    expect(state.auth.connections).toEqual([]);
    expect(console.calls.filter((call) => call.method === 'warn')).toEqual([]);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

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

it('preserves refreshed and newly added connections during scoped logout', async () => {
  const snapshot = getDefaultState('1.0.0');
  const active = {
    id: 'unrelated',
    type: 'on-premise' as const,
    serverUrl: 'https://unrelated.example.test',
    authenticatedAt: '2026-01-01T00:00:00.000Z',
  };
  snapshot.auth = {
    isAuthenticated: true,
    activeConnectionId: active.id,
    connections: [
      active,
      { ...active, id: 'selected', serverUrl: 'https://sample.example.test/base' },
      { ...active, id: 'refreshed', serverUrl: 'http://sample.example.test:9000/other' },
    ],
  };
  const latest = structuredClone(snapshot);
  latest.auth.connections[2].authenticatedAt = '2026-01-02T00:00:00.000Z';
  latest.auth.connections.push({
    ...active,
    id: 'added',
    serverUrl: 'https://sample.example.test:9443',
  });
  const spies = [
    spyOn(stateRepository, 'loadState').mockReturnValue(snapshot),
    spyOn(stateRepository, 'updateState').mockImplementation((update) => update(latest)),
    spyOn(keychain, 'getToken').mockResolvedValue('fixture-token'),
    spyOn(keychain, 'deleteToken').mockResolvedValue(undefined),
  ];
  try {
    const console = new FakeConsole();
    await authLogout(new CommandInvocationContext(console), {
      server: 'https://SAMPLE.example.test/base/',
    });
    expect(latest.auth.connections.map((connection) => connection.id)).toEqual([
      'unrelated',
      'refreshed',
      'added',
    ]);
    expect(latest.auth.activeConnectionId).toBe(active.id);
    expect(latest.auth.isAuthenticated).toBe(true);
    expect(spies[3]).toHaveBeenCalledTimes(1);
    expect(console.findCall('warn', 'The newer connection was kept in state.')).toBeDefined();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

it.each(['getToken', 'deleteToken'] as const)(
  'continues scoped cleanup when %s fails',
  async (operation) => {
    const state = getDefaultState('1.0.0');
    state.auth.connections = [
      {
        id: 'inactive',
        type: 'on-premise',
        serverUrl: 'https://sample.example.test',
        authenticatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const spies = [
      spyOn(stateRepository, 'loadState').mockReturnValue(structuredClone(state)),
      spyOn(stateRepository, 'updateState').mockImplementation((update) => update(state)),
      spyOn(keychain, 'getToken').mockResolvedValue(null),
      spyOn(keychain, 'deleteToken').mockResolvedValue(undefined),
    ];
    const failureSpy = spyOn(keychain, operation).mockRejectedValue(new Error('fixture failure'));
    try {
      const console = new FakeConsole();
      await authLogout(new CommandInvocationContext(console), {
        server: 'https://sample.example.test',
      });
      expect(state.auth.connections).toEqual([]);
      expect(state.auth.isAuthenticated).toBe(false);
      expect(console.findCall('warn', 'Continuing with local logout.')).toBeDefined();
    } finally {
      failureSpy.mockRestore();
      for (const spy of spies) spy.mockRestore();
    }
  },
);
