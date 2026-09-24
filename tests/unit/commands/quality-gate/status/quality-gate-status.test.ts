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

import { qualityGateStatus } from '@/commands/quality-gate/status/index.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { createCliRuntime } from '@/core/commands/cli-runtime.ts';
import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';

const mockAuth = new ResolvedAuth({
  token: 'test-token',
  serverUrl: 'https://sonar.example.com',
  connectionType: 'on-premise',
  source: 'state' as const,
});

describe('qualityGateStatus', () => {
  it('rejects an invalid --format value before making any network call', async () => {
    const fake = new FakeConsole();
    const httpClient = new SonarHttpClient(mockAuth.serverUrl, mockAuth.token);
    const ctx = new CommandAuthenticatedInvocationContext(
      mockAuth,
      fake,
      undefined,
      createCliRuntime({ httpClientFactory: () => httpClient }),
    );

    try {
      await qualityGateStatus({ format: 'xml' }, ctx);
      expect.unreachable('qualityGateStatus should reject an invalid format');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidOptionError);
      expect((err as Error).message).toBe("Invalid format: 'xml'. Must be one of: json, table");
    }
  });
});
