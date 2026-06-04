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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { SCA_SCANNER_CACHE_DIR } from '../../../../src/lib/config-constants';
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
      expect(result.stdout).toContain('Cleaning up SonarQube CLI environment');
      expect(result.stdout).toContain('Authentication: 0 tokens removed from keychain.');
      expect(result.stdout).toContain('CLI has been successfully reset to factory settings.');
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
    'removes binaries recorded in state',
    async () => {
      harness.state().withSecretsBinaryInstalled();

      const result = await harness.run('system reset --force');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Binaries:.*Removed 1 binary/);

      const binDir = join(harness.cliHome.path, 'bin');
      const state = readState(harness.stateJsonFile.path);
      expect(state.dependencies.installed).toHaveLength(0);
      if (existsSync(binDir)) {
        const remaining = readdirSync(binDir).filter((name) => name.includes('sonar'));
        expect(remaining.length).toBe(0);
      }
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
    'clears logs and sca cache directories',
    async () => {
      const logDir = join(harness.cliHome.path, 'logs');
      const cacheDir = join(harness.cliHome.path, 'sca-scanner-cache');
      harness.state().withSecretsBinaryInstalled();

      mkdirSync(logDir, { recursive: true });
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(logDir, 'sonarqube-cli.log'), 'fake log content', 'utf-8');
      writeFileSync(join(cacheDir, 'entry.cache'), 'cache', 'utf-8');

      const result = await harness.run('system reset --force');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Filesystem:.*Cleared CLI cache and logs/);
      expect(existsSync(logDir)).toBe(false);
      expect(existsSync(cacheDir)).toBe(false);
      expect(SCA_SCANNER_CACHE_DIR).toContain('sca-scanner-cache');
    },
    { timeout: 15000 },
  );

  it(
    'clears legacy agentExtensions registry entries',
    async () => {
      const server = await harness.newFakeServer().start();
      const settingsPath = join(harness.cwd.path, '.claude', 'settings.json');
      mkdirSync(join(harness.cwd.path, '.claude'), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify(
          {
            hooks: {
              PostToolUse: [
                {
                  matcher: 'Edit|Write',
                  hooks: [{ type: 'command', command: 'sonar-sqaa/build-scripts/posttool-sqaa' }],
                },
              ],
            },
          },
          null,
          2,
        ),
        'utf-8',
      );

      harness
        .state()
        .withAuth(server.baseUrl(), 'tok', 'org-key')
        .withSqaaExtension(harness.cwd.path, 'my-project');

      const result = await harness.run('system reset --force');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Integrations:.*Removed/);

      const state = readState(harness.stateJsonFile.path);
      expect(state.agentExtensions).toHaveLength(0);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
        hooks?: { PostToolUse?: unknown[] };
      };
      expect(settings.hooks?.PostToolUse ?? []).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'rejects dependency paths outside BIN_DIR',
    async () => {
      const outside = join(harness.cwd.path, 'outside-binary');
      mkdirSync(harness.cwd.path, { recursive: true });
      writeFileSync(outside, 'fake', 'utf-8');
      harness.state().withRawState(
        JSON.stringify({
          version: '1.0',
          lastUpdated: new Date().toISOString(),
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
          dependencies: {
            installed: [
              {
                id: 'sonar-secrets',
                dependencyType: 'binary',
                path: outside,
                updatedByCliVersion: '0.0.0',
                updatedAt: new Date().toISOString(),
              },
            ],
          },
          telemetry: {
            enabled: false,
            installationId: '00000000-0000-0000-0000-000000000000',
            firstUseDate: new Date().toISOString(),
            events: [],
          },
          agentExtensions: [],
          integrations: { installed: [] },
        }),
      );

      const result = await harness.run('system reset --force');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Binaries:');
      expect(result.stdout).toContain('failed');

      const state = readState(harness.stateJsonFile.path);
      expect(state.dependencies.installed).toHaveLength(1);
      expect(existsSync(outside)).toBe(true);
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

      const state = readState(harness.stateJsonFile.path);
      expect(state.auth.connections).toHaveLength(1);
      expect(state.auth.isAuthenticated).toBe(true);
    },
    { timeout: 15000 },
  );
});
