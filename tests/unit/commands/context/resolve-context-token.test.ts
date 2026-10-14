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

import { resolveContextToken } from '@/commands/context/index.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { clearSecretCache } from '@/core/host/keychain.ts';

const auth = {
  serverUrl: 'https://active.example.com',
  orgKey: 'active-org',
  token: 'active-token',
} as ResolvedAuth;
const recordedUrl = 'https://recorded.example.com';
const recordedOrg = 'recorded-org';

describe('resolveContextToken', () => {
  let savedKeychainFile: string | undefined;

  beforeEach(() => {
    savedKeychainFile = process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
    delete process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
    clearSecretCache();
  });

  afterEach(() => {
    if (savedKeychainFile === undefined) {
      delete process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
    } else {
      process.env.SONARQUBE_CLI_KEYCHAIN_FILE = savedKeychainFile;
    }
    clearSecretCache();
  });

  it('propagates keychain access failures with repair advice', async () => {
    const getSpy = spyOn(Bun.secrets, 'get').mockRejectedValue(new Error('keychain locked'));
    try {
      let caught: unknown;
      try {
        await resolveContextToken(auth, recordedUrl, recordedOrg);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CommandFailedError);
      const error = caught as CommandFailedError;
      expect(error.message).toContain('keychain locked');
      expect(error.message).not.toContain('Not authenticated for the recorded');
      expect(error.remediationHint).toContain('unlocked');
    } finally {
      getSpy.mockRestore();
    }
  });

  if (process.platform === 'linux') {
    it('uses recorded-connection advice when libsecret is absent', async () => {
      const getSpy = spyOn(Bun.secrets, 'get').mockRejectedValue(
        new Error('libsecret not available'),
      );
      try {
        let caught: unknown;
        try {
          await resolveContextToken(auth, recordedUrl, recordedOrg);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(CommandFailedError);
        const error = caught as CommandFailedError;
        expect(error.message).toContain(
          'Not authenticated for the recorded Vortex Context connection',
        );
        expect(error.remediationHint).toContain('SONARQUBE_CLI_TOKEN');
        expect(error.remediationHint).toContain(`SONARQUBE_CLI_SERVER=${recordedUrl}`);
      } finally {
        getSpy.mockRestore();
      }
    });
  }
});
