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

// Integration tests for `sonar system reset`

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { generateKeychainAccount } from '../../../../src/lib/keychain';
import { TestHarness } from '../../harness';

interface AuthSnapshot {
  isAuthenticated: boolean;
  connections: unknown[];
  activeConnectionId: string | undefined;
}

interface TelemetrySnapshot {
  enabled: boolean;
  installationId?: string;
  firstUseDate: string;
  events: unknown[];
}

interface ResetStateSnapshot {
  auth: AuthSnapshot;
  telemetry: TelemetrySnapshot;
  tools?: { installed: Array<{ name: string }> };
  dependencies: { installed: Array<{ id: string }> };
  agentExtensions: unknown[];
  integrations: { installed: unknown[] };
}

function readState(stateJsonPath: string): ResetStateSnapshot {
  return JSON.parse(readFileSync(stateJsonPath, 'utf-8')) as ResetStateSnapshot;
}

function readKeychainTokens(keychainFile: string): Record<string, string> {
  if (!existsSync(keychainFile)) return {};
  try {
    return (JSON.parse(readFileSync(keychainFile, 'utf-8')) as { tokens: Record<string, string> })
      .tokens;
  } catch {
    return {};
  }
}

describe('system reset --force', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'succeeds on an empty environment and prints all four status lines',
    async () => {
      const result = await harness.run('system reset --force');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Reset');
      expect(result.stdout).toContain('Authentication: 0 tokens removed from keychain.');
      expect(result.stdout).toContain('Binaries: Pending CLI-565.');
      expect(result.stdout).toContain('Integrations: Pending CLI-565.');
      expect(result.stdout).toContain('CLI has been partially reset.');
    },
    { timeout: 15000 },
  );

  it(
    'purges seeded auth tokens from keychain and state',
    async () => {
      const server = await harness.newFakeServer().start();
      harness.state().withAuth(server.baseUrl(), 'seeded-token');

      const result = await harness.run('system reset --force');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Authentication: 1 tokens removed from keychain.');

      const account = generateKeychainAccount(server.baseUrl());
      expect(readKeychainTokens(harness.keychainJsonFile)[account]).toBeUndefined();

      const state = readState(harness.stateJsonFile.path);
      expect(state.auth.connections).toHaveLength(0);
      expect(state.auth.activeConnectionId).toBeUndefined();
      expect(state.auth.isAuthenticated).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'prints binary cleanup stub (CLI-565 will wire WholeFileResource.remove)',
    async () => {
      harness.state().withSecretsBinaryInstalled();

      const result = await harness.run('system reset --force');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Binaries: Pending CLI-565.');
    },
    { timeout: 15000 },
  );

  it(
    'preserves telemetry installationId, firstUseDate, and events',
    async () => {
      const expectedInstallationId = '11111111-2222-3333-4444-555555555555';
      const expectedFirstUseDate = '2020-01-01T00:00:00.000Z';
      harness.state().withRawState(
        JSON.stringify({
          version: '1.0',
          lastUpdated: expectedFirstUseDate,
          auth: { isAuthenticated: false, connections: [] },
          agents: {
            'claude-code': {
              configured: false,
              hooks: { installed: [] },
              skills: { installed: [] },
            },
          },
          config: { cliVersion: '0.0.0' },
          tools: { installed: [] },
          dependencies: { installed: [] },
          telemetry: {
            enabled: true,
            installationId: expectedInstallationId,
            firstUseDate: expectedFirstUseDate,
            events: [],
          },
          agentExtensions: [],
          integrations: { installed: [] },
        }),
      );

      const result = await harness.run('system reset --force');
      expect(result.exitCode).toBe(0);

      const after = readState(harness.stateJsonFile.path).telemetry;
      expect(after.installationId).toBe(expectedInstallationId);
      expect(after.firstUseDate).toBe(expectedFirstUseDate);
      expect(after.enabled).toBe(true);
    },
    { timeout: 15000 },
  );

  it(
    'clears the logs directory but leaves bin alone',
    async () => {
      const binDir = join(harness.cliHome.path, 'bin');
      const logDir = join(harness.cliHome.path, 'logs');
      harness.state().withSecretsBinaryInstalled();

      await harness.run('auth status');
      writeFileSync(join(logDir, 'sonarqube-cli.log'), 'fake log content', 'utf-8');

      const result = await harness.run('system reset --force');

      expect(result.exitCode).toBe(0);
      expect(existsSync(logDir)).toBe(false);
      // BIN_DIR cleanup belongs to CLI-565 (removeBinaries via WholeFileResource).
      expect(existsSync(binDir)).toBe(true);
    },
    { timeout: 15000 },
  );

  it(
    'leaves integration state alone (CLI-565 stub)',
    async () => {
      const server = await harness.newFakeServer().start();
      harness
        .state()
        .withAuth(server.baseUrl(), 'tok', 'org-key')
        .withSqaaExtension(harness.cwd.path, 'my-project');

      const result = await harness.run('system reset --force');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Integrations: Pending CLI-565.');

      // The stub reports nothing cleaned, so agentExtensions and integrations.installed
      // are preserved in state — the user can see what still needs cleanup once CLI-565 is wired.
      const state = readState(harness.stateJsonFile.path);
      expect(state.agentExtensions).toHaveLength(1);
      expect(state.integrations.installed).toHaveLength(0); // seeded via agentExtensions, not integrations
    },
    { timeout: 15000 },
  );
});

describe('system reset (no --force)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'cancels with a --force hint when stdin is not a TTY',
    async () => {
      const server = await harness.newFakeServer().start();
      harness.state().withAuth(server.baseUrl(), 'seeded-token');

      const result = await harness.run('system reset');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        'Reset cancelled. Use --force to skip the prompt in non-interactive mode.',
      );

      // Auth must still be intact — no cleanup ran.
      const state = readState(harness.stateJsonFile.path);
      expect(state.auth.connections).toHaveLength(1);
      expect(state.auth.isAuthenticated).toBe(true);
    },
    { timeout: 15000 },
  );
});
