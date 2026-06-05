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

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { nativeGitIntegration } from '../../../../src/cli/commands/integrate/git/tools/native';
import { SCA_SCANNER_CACHE_DIR } from '../../../../src/lib/config-constants';
import { generateKeychainAccount } from '../../../../src/lib/keychain';
import { TestHarness } from '../../harness';
import { buildHomeEnv, IS_WINDOWS } from '../../harness/platform';

/** Unix-only: verify chmod 555 actually blocks recursive removal on this host. */
function unixChmodBlocksDirectoryRemoval(): boolean {
  if (IS_WINDOWS || typeof process.getuid !== 'function' || process.getuid() === 0) {
    return false;
  }

  const probeDir = mkdtempSync(join(tmpdir(), 'sonar-reset-probe-'));
  try {
    writeFileSync(join(probeDir, 'probe'), 'x');
    chmodSync(probeDir, 0o555);
    try {
      rmSync(probeDir, { recursive: true, force: true });
      return false;
    } catch {
      return true;
    }
  } finally {
    if (existsSync(probeDir)) {
      chmodSync(probeDir, 0o755);
      rmSync(probeDir, { recursive: true, force: true });
    }
  }
}

const SKIP_CHMOD_REMOVAL_TEST = IS_WINDOWS || !unixChmodBlocksDirectoryRemoval();

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

/**
 * Builds a complete state.json string with the given agent extensions and/or
 * installed integrations for declarative reset tests.
 */
function buildRawState(overrides: {
  agentExtensions?: unknown[];
  integrations?: unknown[];
}): string {
  return JSON.stringify({
    version: '1.0',
    lastUpdated: new Date().toISOString(),
    auth: { isAuthenticated: false, connections: [] },
    agents: {
      'claude-code': { configured: false, hooks: { installed: [] }, skills: { installed: [] } },
    },
    config: { cliVersion: '0.0.0' },
    tools: { installed: [] },
    dependencies: { installed: [] },
    telemetry: {
      enabled: false,
      installationId: '00000000-0000-0000-0000-000000000000',
      firstUseDate: new Date().toISOString(),
      events: [],
    },
    agentExtensions: overrides.agentExtensions ?? [],
    integrations: { installed: overrides.integrations ?? [] },
  });
}

function gitEnv(userHome: string): NodeJS.ProcessEnv {
  return { ...process.env, ...buildHomeEnv(userHome) };
}

/** Sets global `core.hooksPath` via git so reads/writes match production behavior. */
function setGlobalHooksPath(userHome: string, hooksDir: string): void {
  mkdirSync(userHome, { recursive: true });
  const result = Bun.spawnSync(['git', 'config', '--global', 'core.hooksPath', hooksDir], {
    env: gitEnv(userHome),
  });
  if (result.exitCode !== 0) {
    throw new Error(`git config failed: ${result.stderr.toString()}`);
  }
}

function getGlobalHooksPath(userHome: string): string | undefined {
  const result = Bun.spawnSync(['git', 'config', '--global', '--get', 'core.hooksPath'], {
    env: gitEnv(userHome),
  });
  if (result.exitCode !== 0) {
    return undefined;
  }
  return result.stdout.toString().trim();
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
      expect(result.stdout).toContain('Authentication: 1 token removed from keychain.');

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
    'warns and still removes local auth when server-side token revocation fails',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('reset-token')
        .withTokenRevocationFailure(500, 'revocation boom')
        .start();
      harness
        .state()
        .withAuth(server.baseUrl(), 'reset-token')
        .withTokenName('cli-reset-token')
        .withKeychainToken(server.baseUrl(), 'reset-token');

      const result = await harness.run('system reset --force');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        `Failed to revoke the server-side token "cli-reset-token": SonarQube API error: 500 Internal Server Error - revocation boom for ${server.baseUrl()}. Continuing with local reset.`,
      );
      expect(result.stdout).toContain('Authentication: 1 token removed from keychain.');

      const account = generateKeychainAccount(server.baseUrl());
      expect(readKeychainTokens(harness.keychainJsonFile)[account]).toBeUndefined();
      const state = readState(harness.stateJsonFile.path);
      expect(state.auth.connections).toHaveLength(0);
      expect(state.auth.isAuthenticated).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'purges every token when multiple connections are reset together',
    async () => {
      const now = new Date().toISOString();
      const connection = (id: string, serverUrl: string, orgKey?: string) => ({
        id,
        type: orgKey ? 'cloud' : 'on-premise',
        serverUrl,
        orgKey,
        authenticatedAt: now,
      });
      const raw = JSON.parse(buildRawState({})) as Record<string, unknown>;
      raw.auth = {
        isAuthenticated: true,
        activeConnectionId: 'conn-a',
        connections: [
          connection('conn-a', 'https://sonar-a.example'),
          connection('conn-b', 'https://sonar-b.example', 'org-b'),
          connection('conn-c', 'https://sonar-c.example'),
        ],
      };
      harness
        .state()
        .withRawState(JSON.stringify(raw))
        .withKeychainToken('https://sonar-a.example', 'tok-a')
        .withKeychainToken('https://sonar-b.example', 'tok-b', 'org-b')
        .withKeychainToken('https://sonar-c.example', 'tok-c');

      const result = await harness.run('system reset --force');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Authentication: 3 tokens removed from keychain.');
      expect(Object.keys(readKeychainTokens(harness.keychainJsonFile))).toHaveLength(0);

      const state = readState(harness.stateJsonFile.path);
      expect(state.auth.connections).toHaveLength(0);
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
    'reports cleared size for nested cache directories with large files',
    async () => {
      const logDir = join(harness.cliHome.path, 'logs');
      const nestedDir = join(logDir, 'nested');
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(join(logDir, 'root.log'), 'x'.repeat(2048), 'utf-8');
      writeFileSync(join(nestedDir, 'child.log'), 'y'.repeat(1024 * 1024), 'utf-8');

      const result = await harness.run('system reset --force');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Filesystem:.*Cleared CLI cache and logs \(1MB cleared\)/);
      expect(existsSync(logDir)).toBe(false);
    },
    { timeout: 15000 },
  );

  it.skipIf(SKIP_CHMOD_REMOVAL_TEST)(
    'warns and exits 1 when a cache directory cannot be removed',
    async () => {
      const logDir = join(harness.cliHome.path, 'logs');
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, 'sonarqube-cli.log'), 'fake log content', 'utf-8');
      chmodSync(logDir, 0o555);

      try {
        const result = await harness.run('system reset --force');

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toMatch(/Filesystem:.*Failed to clear some directories/);
        expect(result.stderr).toContain('System reset completed with warnings');
        expect(existsSync(logDir)).toBe(true);
      } finally {
        if (existsSync(logDir)) {
          chmodSync(logDir, 0o755);
        }
      }
    },
    { timeout: 15000 },
  );

  it(
    'clears agentExtensions registry entries without legacy disk cleanup',
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
      expect(result.stdout).toMatch(/Integrations:.*Nothing to remove/);

      const state = readState(harness.stateJsonFile.path);
      expect(state.agentExtensions).toHaveLength(0);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
        hooks?: { PostToolUse?: unknown[] };
      };
      expect(settings.hooks?.PostToolUse ?? []).toHaveLength(1);
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

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Binaries:');
      expect(result.stdout).toContain('failed');
      expect(result.stderr).toContain('System reset completed with warnings');

      const state = readState(harness.stateJsonFile.path);
      expect(state.dependencies.installed).toHaveLength(1);
      expect(existsSync(outside)).toBe(true);
    },
    { timeout: 15000 },
  );

  it(
    'reports stale binary state entries without claiming a file was removed',
    async () => {
      const stalePath = join(harness.cliHome.path, 'bin', 'missing-sonar-secrets');
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
                path: stalePath,
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
      expect(result.stdout).toMatch(/Binaries:.*Cleared 1 stale binary entry from state/);
      expect(result.stdout).not.toMatch(/Removed 1 binary/);
      expect(readState(harness.stateJsonFile.path).dependencies.installed).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'removes sca-scanner-cli recorded only in tools.installed',
    async () => {
      harness.state().withScaScannerBinaryInstalled();

      const result = await harness.run('system reset --force');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Binaries:.*Removed 1 binary/);

      const state = readState(harness.stateJsonFile.path);
      expect(state.tools?.installed ?? []).toHaveLength(0);
      const binDir = join(harness.cliHome.path, 'bin');
      if (existsSync(binDir)) {
        const remaining = readdirSync(binDir).filter((name) => name.includes('sca-scanner'));
        expect(remaining.length).toBe(0);
      }
    },
    { timeout: 15000 },
  );

  it(
    'warns and exits 1 when state references an unknown integration',
    async () => {
      harness.state().withRawState(
        buildRawState({
          integrations: [
            {
              id: 'integration-1',
              integrationId: 'made-up-agent',
              installedByCliVersion: '0.0.0',
              installedAt: new Date().toISOString(),
              updatedByCliVersion: '0.0.0',
              updatedAt: new Date().toISOString(),
              features: [
                {
                  featureId: 'some-feature',
                  scope: 'project',
                  targetRoot: harness.cwd.path,
                  installedByCliVersion: '0.0.0',
                  installedAt: new Date().toISOString(),
                  updatedByCliVersion: '0.0.0',
                  updatedAt: new Date().toISOString(),
                  dependencies: [],
                  resources: [],
                  operations: [],
                  attrs: {},
                },
              ],
            },
          ],
        }),
      );

      const result = await harness.run('system reset --force');

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/Integrations:.*unknown integration/);
      expect(result.stderr).toContain('System reset completed with warnings');

      // The unknown integration could not be removed, so it stays in state.
      expect(readState(harness.stateJsonFile.path).integrations.installed).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'undoes a global native git hook integration and unsets the Sonar hooks path',
    async () => {
      const hooksDir = join(harness.cliHome.path, 'hooks');
      setGlobalHooksPath(harness.userHome.path, hooksDir);
      harness
        .state()
        .withInstalledIntegrationFeature(
          nativeGitIntegration,
          'pre-commit-hook',
          'global',
          hooksDir,
        );

      const result = await harness.run('system reset --force');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Integrations:.*Removed/);
      expect(readState(harness.stateJsonFile.path).integrations.installed).toHaveLength(0);
      expect(getGlobalHooksPath(harness.userHome.path)).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it(
    'leaves a user-managed global hooks path untouched on undo',
    async () => {
      const userHooksDir = join(harness.cwd.path, 'my-own-hooks');
      setGlobalHooksPath(harness.userHome.path, userHooksDir);
      harness
        .state()
        .withInstalledIntegrationFeature(
          nativeGitIntegration,
          'pre-commit-hook',
          'global',
          join(harness.cliHome.path, 'hooks'),
        );

      const result = await harness.run('system reset --force');

      expect(result.exitCode).toBe(0);
      expect(getGlobalHooksPath(harness.userHome.path)).toBe(userHooksDir);
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
