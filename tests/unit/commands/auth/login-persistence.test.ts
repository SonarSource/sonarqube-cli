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

import { describe, expect, it, spyOn } from 'bun:test';

import {
  assertNoCleartextTokenDowngrade,
  httpsTokenDowngradeTarget,
  persistLoginCredentials,
} from '@/commands/auth/persist-login.ts';
import * as revocation from '@/commands/auth/revoke-server-token.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import * as keychain from '@/core/host/keychain.ts';
import { normalizeServerUrl } from '@/core/host/keychain.ts';
import { shellQuote } from '@/core/host/shell-quote.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as repository from '@/core/state/state-repository.ts';

describe('login persistence', () => {
  it('rejects an incompatible connection before any mutations or revocation', async () => {
    const state = getDefaultState('1.0.0');
    state.auth.connections.push({
      id: 'saved',
      type: 'on-premise',
      serverUrl: 'https://sample.example.test',
      authenticatedAt: '2026-01-01T00:00:00.000Z',
      tokenName: 'sample',
    });
    const spies = [
      spyOn(repository, 'loadState').mockReturnValue(state),
      spyOn(repository, 'updateState'),
      spyOn(keychain, 'saveToken'),
      spyOn(keychain, 'deleteStaleTokens'),
      spyOn(revocation, 'revokeServerTokenIfPossible'),
    ];
    try {
      await persistLoginCredentials(
        'http://sample.example.test',
        false,
        undefined,
        'replacement-token',
      ).then(
        () => {
          throw new Error('Expected rejection');
        },
        (error: Error) => {
          expect(error.message).toContain('Cannot connect');
        },
      );
      for (const spy of spies.slice(1)) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('suggests a quoted saved URL without user information', () => {
    const saved = "https://fixture-user:fixture-password@sample.example.test/base';echo";
    const state = getDefaultState('1.0.0');
    state.auth.connections.push({
      id: 'saved',
      type: 'on-premise',
      serverUrl: saved,
      authenticatedAt: '2026-01-01T00:00:00.000Z',
    });
    const spy = spyOn(repository, 'loadState').mockReturnValue(state);
    try {
      let error: unknown;
      try {
        assertNoCleartextTokenDowngrade('http://sample.example.test');
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(CommandFailedError);
      const hint = (error as CommandFailedError).remediationHint;
      expect(hint).toContain(`sonar auth logout --server ${shellQuote(normalizeServerUrl(saved))}`);
      expect(hint).not.toContain('fixture-user');
      expect(hint).not.toContain('fixture-password');
    } finally {
      spy.mockRestore();
    }
  });

  it('preserves HTTPS selection and ignores invalid saved URLs', () => {
    const connections = [{ serverUrl: 'invalid' }, { serverUrl: 'https://sample.example.test' }];
    expect(httpsTokenDowngradeTarget(connections, 'https://sample.example.test')).toBeUndefined();
    expect(httpsTokenDowngradeTarget(connections, 'http://sample.example.test')).toBe(
      'https://sample.example.test',
    );
  });
});
