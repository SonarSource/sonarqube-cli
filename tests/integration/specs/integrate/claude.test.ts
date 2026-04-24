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

// Integration tests for `sonar integrate claude`

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { version as CURRENT_VERSION } from '../../../../package.json';
import { buildLocalBinaryName } from '../../../../src/cli/commands/_common/install/secrets.js';
import { detectPlatform } from '../../../../src/lib/platform-detector.js';
import {
  hookScriptName,
  hookScriptPath,
  IS_WINDOWS,
  normalizePath,
  TestHarness,
} from '../../harness';

describe('integrate claude', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    await harness.newFakeBinariesServer().start();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  // --- Without --non-interactive (auth succeeds, no repair triggered) ---

  it(
    'performs full integration with auth from state and URL from sonar-project.properties',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.exists('.claude', 'settings.json')).toBe(true);
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          hookScriptName('pretool-secrets'),
        ),
      ).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'uses SONARQUBE_CLI_TOKEN + SONARQUBE_CLI_SERVER env vars for full integration',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('env-token')
        .withProject('env-project')
        .start();

      // sonar-project.properties has only the project key — no sonar.host.url,
      // so the server URL must come exclusively from SONARQUBE_CLI_SERVER env var
      harness.cwd.writeFile('sonar-project.properties', 'sonar.projectKey=env-project');

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_TOKEN: 'env-token',
          SONARQUBE_CLI_SERVER: server.baseUrl(),
        },
      });

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.exists('.claude', 'settings.json')).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'uses keychain token for full integration',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('keychain-token')
        .withProject('keychain-project')
        .start();
      harness.withAuth(server.baseUrl(), 'keychain-token');
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=keychain-project'].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.exists('.claude', 'settings.json')).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'installs secrets-only hooks when sonar-project.properties has URL but no project key',
    async () => {
      const server = await harness.newFakeServer().start();
      harness.withAuth(server.baseUrl(), 'some-token');
      harness.state().withSecretsBinaryInstalled();
      harness.cwd.writeFile('sonar-project.properties', `sonar.host.url=${server.baseUrl()}`);

      const result = await harness.run('integrate claude --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          hookScriptName('pretool-secrets'),
        ),
      ).toBe(true);
    },
    { timeout: 30000 },
  );

  // --- Without --non-interactive (interactive browser auth via browserToken) ---

  it(
    'triggers browser auth repair when stored token fails health check',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('browser-token')
        .withProject('browser-project')
        .start();

      // Set up auth with an invalid token so health check fails and repair is triggered
      harness.withAuth(server.baseUrl(), 'initial-invalid-token');
      harness.state().withSecretsBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=browser-project'].join('\n'),
      );

      const result = await harness.run('integrate claude', {
        browserToken: 'browser-token',
      });

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.exists('.claude', 'settings.json')).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'replaces invalid token via browser auth and completes full integration',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-browser-token')
        .withProject('repair-project')
        .start();
      harness.withAuth(server.baseUrl(), 'invalid-token');
      harness.state().withSecretsBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=repair-project'].join('\n'),
      );

      const result = await harness.run('integrate claude', {
        browserToken: 'valid-browser-token',
      });

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.exists('.claude', 'settings.json')).toBe(true);
    },
    { timeout: 30000 },
  );

  // --- With --non-interactive ---

  it(
    'installs hooks even when token is invalid (--non-interactive degraded mode)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'wrong-token');
      harness.state().withSecretsBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          hookScriptName('pretool-secrets'),
        ),
      ).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'installs hooks in degraded mode when token is invalid and --non-interactive',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('some-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'wrong-token');
      harness.state().withSecretsBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          hookScriptName('pretool-secrets'),
        ),
      ).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'does not open browser when env vars are set but token is invalid (env vars imply non-interactive)',
    async () => {
      // Regression test: when SONARQUBE_CLI_TOKEN + SONARQUBE_CLI_SERVER are set but the token is
      // rejected by the server, the command must NOT open a browser — env vars imply CI/automated
      // context. Without the fix this test hangs (browser auth is triggered, loopback server waits).
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-token') // server only accepts 'valid-token'
        .withProject('my-project')
        .start();
      harness.state().withSecretsBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      const result = await harness.run(
        'integrate claude', // no --non-interactive flag
        {
          extraEnv: {
            SONARQUBE_CLI_TOKEN: 'invalid-token', // rejected by server → tokenValid = false
            SONARQUBE_CLI_SERVER: server.baseUrl(),
            // no browserToken: if browser auth is triggered the test times out
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          hookScriptName('pretool-secrets'),
        ),
      ).toBe(true);
    },
    { timeout: 15000 },
  );

  it(
    'warns about missing SONARQUBE_CLI_SERVER when only SONARQUBE_CLI_TOKEN is set',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('some-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'some-token');
      harness.state().withSecretsBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: { SONARQUBE_CLI_TOKEN: 'some-token' },
      });

      expect(result.exitCode).toBe(0);
      // warn() outputs to stderr
      expect(result.stderr).toContain('SONARQUBE_CLI_SERVER');
    },
    { timeout: 30000 },
  );

  it(
    'uses auth server URL and makes requests to the server',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      harness.state().withSecretsBinaryInstalled();

      const result = await harness.run('integrate claude --non-interactive');

      expect(result.exitCode).toBe(0);
      const requests = server.getRecordedRequests();
      expect(requests.length).toBeGreaterThan(0);
    },
    { timeout: 30000 },
  );

  it(
    'performs full integration using --project flag without sonar-project.properties',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('flag-token')
        .withProject('flag-project')
        .start();
      harness.withAuth(server.baseUrl(), 'flag-token');

      const result = await harness.run(`integrate claude --project flag-project --non-interactive`);

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.exists('.claude', 'settings.json')).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'installs settings.json with PreToolUse hook on full integration',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      harness.state().withSecretsBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive');

      expect(result.exitCode).toBe(0);
      const claudeSettingsFile = harness.cwd.file('.claude', 'settings.json');
      expect(claudeSettingsFile.exists()).toBe(true);
      const settings = claudeSettingsFile.asJson();
      expect(settings.hooks?.PreToolUse).toBeDefined();
    },
    { timeout: 30000 },
  );

  it(
    'pretool-secrets script exists and is executable after integration',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      harness.state().withSecretsBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      await harness.run('integrate claude --non-interactive');

      const preToolScriptFile = harness.cwd.file(
        '.claude',
        'hooks',
        'sonar-secrets',
        'build-scripts',
        hookScriptName('pretool-secrets'),
      );
      expect(preToolScriptFile.exists()).toBe(true);
      expect(preToolScriptFile.isExecutable).toBe(true);
    },
    { timeout: 30000 },
  );
  it(
    'prompt-secrets.sh uses correct subcommand (sonar hook claude-prompt-submit) after integration',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      harness.state().withSecretsBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      await harness.run('integrate claude --non-interactive');

      const promptScriptContent = harness.cwd
        .file(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          hookScriptName('prompt-secrets'),
        )
        .asText();
      expect(promptScriptContent).toContain('sonar hook claude-prompt-submit');
      expect(promptScriptContent).not.toContain('sonar analyze --file');
    },
    { timeout: 30000 },
  );

  it(
    'exits with code 1 and prompts to authenticate when no auth is configured',
    async () => {
      const result = await harness.run('integrate claude --non-interactive');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        '❌ Not authenticated. Run: sonar auth login',
      );
    },
    { timeout: 15000 },
  );
});

// ─── SQAA entitlement guard ────────────────────────────────────────────────────

describe('integrate claude — SQAA entitlement guard', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'installs PostToolUse SQAA hook when Cloud org has SQAA entitlement (repair path)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('cloud-token')
        .withOrganizations([{ key: 'my-org', name: 'My Org' }])
        .withSqaaEntitlement('my-org', 'test-uuid-1234')
        .withProject('my-project')
        .start();

      // Point both Cloud URL constants at the fake server so SONARCLOUD_HOSTNAME check passes
      // and getOrganizationId / checkSqaaEntitlement hit the same fake server
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, 'cloud-token', 'my-org');

      const result = await harness.run(`integrate claude --project my-project --non-interactive`, {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const settings = harness.cwd.file('.claude', 'settings.json').asJson();
      expect(settings.hooks?.PostToolUse).toBeDefined();
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-sqaa',
          'build-scripts',
          hookScriptName('posttool-sqaa'),
        ),
      ).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'records sonar-sqaa in agents.claude-code.hooks.installed after fresh SQAA install',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('cloud-token')
        .withOrganizations([{ key: 'my-org', name: 'My Org' }])
        .withSqaaEntitlement('my-org', 'test-uuid-1234')
        .withProject('my-project')
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, 'cloud-token', 'my-org');

      const result = await harness.run(`integrate claude --project my-project --non-interactive`, {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);

      const state = harness.stateJsonFile.asJson();
      const installedHooks = (state.agents?.['claude-code']?.hooks?.installed ?? []) as Array<{
        name: string;
        type: string;
      }>;

      expect(installedHooks.some((h) => h.name === 'sonar-sqaa' && h.type === 'PostToolUse')).toBe(
        true,
      );
    },
    { timeout: 30000 },
  );

  it(
    'does not install PostToolUse SQAA hook when org has no SQAA entitlement (repair path)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('cloud-token')
        .withOrganizations([{ key: 'my-org', name: 'My Org' }])
        .withSqaaEntitlement('my-org', 'test-uuid-1234', { eligible: false, enabled: false })
        .start();

      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, 'cloud-token', 'my-org');

      const result = await harness.run(`integrate claude --non-interactive`, {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const settings = harness.cwd.file('.claude', 'settings.json').asJson();
      expect(settings.hooks?.PostToolUse).toBeUndefined();
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-sqaa',
          'build-scripts',
          hookScriptName('posttool-sqaa'),
        ),
      ).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'sonar-sqaa agentExtension is always project-level even when -g flag is used',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('cloud-token')
        .withOrganizations([{ key: 'my-org', name: 'My Org' }])
        .withSqaaEntitlement('my-org', 'test-uuid-1234')
        .withProject('my-project')
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, 'cloud-token', 'my-org');

      const result = await harness.run(
        `integrate claude -g --project my-project --non-interactive`,
        {
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
            SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
          },
        },
      );

      expect(result.exitCode).toBe(0);

      const state = harness.stateJsonFile.asJson();
      const sqaaExt = (state.agentExtensions as Array<{ name: string; global: boolean }>).find(
        (e) => e.name === 'sonar-sqaa',
      );

      expect(sqaaExt).toBeDefined();
      expect(sqaaExt!.global).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'removes obsolete sonar-a3s hook entry when sonar-sqaa is installed',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('cloud-token')
        .withOrganizations([{ key: 'my-org', name: 'My Org' }])
        .withSqaaEntitlement('my-org', 'test-uuid-1234')
        .withProject('my-project')
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, 'cloud-token', 'my-org');

      // Simulate pre-existing sonar-a3s hook from an older install, plus a third-party hook
      harness.cwd.writeFile(
        '.claude/hooks/sonar-a3s/build-scripts/posttool-a3s.sh',
        '#!/bin/bash\necho old',
      );
      harness.cwd.writeFile(
        '.claude/settings.json',
        JSON.stringify({
          hooks: {
            PostToolUse: [
              {
                matcher: 'Edit|Write',
                hooks: [
                  {
                    type: 'command',
                    command: '.claude/hooks/sonar-a3s/build-scripts/posttool-a3s.sh',
                    timeout: 60,
                  },
                ],
              },
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: '.claude/hooks/some-other-tool/run.sh',
                    timeout: 30,
                  },
                ],
              },
            ],
          },
        }),
      );

      const result = await harness.run(`integrate claude --project my-project --non-interactive`, {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const settings = harness.cwd.file('.claude', 'settings.json').asJson();
      const postToolUseCommands = (
        settings.hooks?.PostToolUse as Array<{ hooks: Array<{ command: string }> }>
      )?.flatMap((e) => e.hooks.map((h) => h.command));
      expect(postToolUseCommands?.some((c: string) => c.includes('sonar-a3s'))).toBe(false);
      expect(postToolUseCommands?.some((c: string) => c.includes('sonar-sqaa'))).toBe(true);
      expect(postToolUseCommands?.some((c: string) => c.includes('some-other-tool'))).toBe(true);
      expect(harness.cwd.exists('.claude', 'hooks', 'sonar-a3s')).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'removes sonar-a3s entries from state.json when SQAA hooks are installed via migration',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('cloud-token')
        .withOrganizations([{ key: 'my-org', name: 'My Org' }])
        .withSqaaEntitlement('my-org', 'test-uuid-1234')
        .withProject('my-project')
        .start();
      const serverUrl = server.baseUrl();

      // Simulate an old install: sonar-a3s is the PostToolUse hook, no sonar-sqaa yet
      const staleState = {
        version: '1.0',
        lastUpdated: new Date().toISOString(),
        auth: {
          isAuthenticated: true,
          connections: [
            {
              id: 'test-conn',
              type: 'cloud',
              serverUrl,
              orgKey: 'my-org',
              authenticatedAt: new Date().toISOString(),
            },
          ],
          activeConnectionId: 'test-conn',
        },
        agents: {
          'claude-code': {
            configured: true,
            configuredByCliVersion: '0.5.0',
            hooks: {
              installed: [
                { name: 'sonar-a3s', type: 'PostToolUse', installedAt: new Date().toISOString() },
                {
                  name: 'sonar-secrets',
                  type: 'PreToolUse',
                  installedAt: new Date().toISOString(),
                },
              ],
            },
            skills: { installed: [] },
          },
        },
        config: { cliVersion: CURRENT_VERSION },
        telemetry: { enabled: false, firstUseDate: new Date().toISOString(), events: [] },
        agentExtensions: [
          {
            id: randomUUID(),
            agentId: 'claude-code',
            projectRoot: harness.cwd.path,
            global: false,
            kind: 'hook',
            name: 'sonar-a3s',
            hookType: 'PostToolUse',
            updatedByCliVersion: '0.5.0',
            updatedAt: new Date().toISOString(),
          },
        ],
      };

      harness
        .state()
        .withRawState(JSON.stringify(staleState))
        .withKeychainToken(serverUrl, 'cloud-token', 'my-org');
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${serverUrl}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      const result = await harness.run(`integrate claude --project my-project --non-interactive`, {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);

      const state = harness.stateJsonFile.asJson();
      const extensions = state.agentExtensions as Array<{ name: string }>;
      const hooks = (state.agents?.['claude-code']?.hooks?.installed ?? []) as Array<{
        name: string;
      }>;

      expect(extensions.some((e) => e.name === 'sonar-a3s')).toBe(false);
      expect(hooks.some((h) => h.name === 'sonar-a3s')).toBe(false);
      expect(extensions.some((e) => e.name === 'sonar-sqaa')).toBe(true);
    },
    { timeout: 30000 },
  );
});

// ─── Local vs Global file placement ──────────────────────────────────────────

describe('integrate claude — file placement (local vs global)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  // ─── Project-level (no -g) ─────────────────────────────────────────────────

  describe('project-level hooks (no -g flag)', () => {
    it(
      'writes hook scripts and settings.json inside projectDir/.claude/',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('tok')
          .withProject('proj')
          .start();
        harness.withAuth(server.baseUrl(), 'tok');
        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
        );

        const result = await harness.run('integrate claude --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists('.claude', 'settings.json')).toBe(true);
        expect(
          harness.cwd.exists(
            '.claude',
            'hooks',
            'sonar-secrets',
            'build-scripts',
            hookScriptName('pretool-secrets'),
          ),
        ).toBe(true);
        expect(
          harness.cwd.exists(
            '.claude',
            'hooks',
            'sonar-secrets',
            'build-scripts',
            hookScriptName('prompt-secrets'),
          ),
        ).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'does not touch the global dir when running without -g',
      async () => {
        harness.withAuth('http://localhost:19999', 'fake-token');
        await harness.run('integrate claude --non-interactive');

        // Global dir must be completely untouched
        expect(harness.userHome.exists('.claude')).toBe(false);
      },
      { timeout: 30000 },
    );

    it(
      'registers hook commands with relative paths in settings.json',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('tok')
          .withProject('proj')
          .start();
        harness.withAuth(server.baseUrl(), 'tok');
        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
        );

        await harness.run('integrate claude --non-interactive');

        const settings = harness.cwd.file('.claude', 'settings.json').asJson();
        const preToolPath = hookScriptPath(String(settings.hooks.PreToolUse[0].hooks[0].command));
        const promptPath = hookScriptPath(
          String(settings.hooks.UserPromptSubmit[0].hooks[0].command),
        );

        // Must be relative (not absolute) so they resolve from the project root
        expect(isAbsolute(preToolPath)).toBe(false);
        expect(preToolPath.startsWith('.claude')).toBe(true);
        expect(isAbsolute(promptPath)).toBe(false);
        expect(promptPath.startsWith('.claude')).toBe(true);
      },
      { timeout: 30000 },
    );
  });

  // ─── Global pre-exists, project install runs ────────────────────

  describe('project-level install when a global Claude hook already exists', () => {
    function writeExistingGlobalSecretsHook(): void {
      // Simulate the on-disk footprint of a previous `sonar integrate claude -g` run:
      // .claude/settings.json with a sonar-secrets PreToolUse entry plus the script file.
      const globalScriptRel =
        '.claude/hooks/sonar-secrets/build-scripts/pretool-secrets' + (IS_WINDOWS ? '.ps1' : '.sh');
      harness.userHome.writeFile(globalScriptRel, '#!/bin/bash\nexit 0\n');
      harness.userHome.writeFile(
        '.claude/settings.json',
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: 'Read',
                hooks: [
                  {
                    type: 'command',
                    command: `${harness.userHome.path}/${globalScriptRel}`,
                    timeout: 60,
                  },
                ],
              },
            ],
          },
        }),
      );
    }

    it(
      'does not create .claude/settings.json in the project directory',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('tok')
          .withProject('proj')
          .start();
        harness.withAuth(server.baseUrl(), 'tok');
        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
        );
        writeExistingGlobalSecretsHook();

        const result = await harness.run('integrate claude --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists('.claude', 'settings.json')).toBe(false);
      },
      { timeout: 30000 },
    );

    it(
      'does not create project-level sonar-secrets scripts',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('tok')
          .withProject('proj')
          .start();
        harness.withAuth(server.baseUrl(), 'tok');
        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
        );
        writeExistingGlobalSecretsHook();

        await harness.run('integrate claude --non-interactive');

        expect(harness.cwd.exists('.claude', 'hooks', 'sonar-secrets')).toBe(false);
      },
      { timeout: 30000 },
    );

    it(
      'prints the "global hook already configured — project-level skipped" message',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('tok')
          .withProject('proj')
          .start();
        harness.withAuth(server.baseUrl(), 'tok');
        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
        );
        writeExistingGlobalSecretsHook();

        const result = await harness.run('integrate claude --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(
          'A global secrets scanning hook is already configured for SonarQube. To avoid duplicate execution, project-level secrets hooks were skipped.',
        );
      },
      { timeout: 30000 },
    );

    it(
      'leaves the pre-existing global settings.json file intact',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('tok')
          .withProject('proj')
          .start();
        harness.withAuth(server.baseUrl(), 'tok');
        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
        );
        writeExistingGlobalSecretsHook();
        const before = harness.userHome.file('.claude', 'settings.json').asText();

        await harness.run('integrate claude --non-interactive');

        const after = harness.userHome.file('.claude', 'settings.json').asText();
        expect(after).toBe(before);
      },
      { timeout: 30000 },
    );

    it(
      'still writes the project-scoped sonar-sqaa hook when the org has SQAA entitlement',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('cloud-token')
          .withOrganizations([{ key: 'my-org', name: 'My Org' }])
          .withSqaaEntitlement('my-org', 'test-uuid-1234')
          .withProject('proj')
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'cloud-token', 'my-org');
        writeExistingGlobalSecretsHook();

        const result = await harness.run(`integrate claude --project proj --non-interactive`, {
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
            SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        // SQAA hook must still land project-locally because it is always project-scoped.
        expect(
          harness.cwd.exists(
            '.claude',
            'hooks',
            'sonar-sqaa',
            'build-scripts',
            hookScriptName('posttool-sqaa'),
          ),
        ).toBe(true);
        // Secrets scripts must NOT be duplicated at project level.
        expect(harness.cwd.exists('.claude', 'hooks', 'sonar-secrets')).toBe(false);
      },
      { timeout: 30000 },
    );
  });

  // ─── Global (-g flag) ──────────────────────────────────────────────────────

  describe('global hooks (-g flag)', () => {
    it(
      'writes hook scripts and settings.json to $HOME/.claude/',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('tok')
          .withProject('proj')
          .start();
        harness.withAuth(server.baseUrl(), 'tok');
        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
        );

        const result = await harness.run('integrate claude -g --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.userHome.exists('.claude', 'settings.json')).toBe(true);
        expect(
          harness.userHome.exists(
            '.claude',
            'hooks',
            'sonar-secrets',
            'build-scripts',
            hookScriptName('pretool-secrets'),
          ),
        ).toBe(true);
        expect(
          harness.userHome.exists(
            '.claude',
            'hooks',
            'sonar-secrets',
            'build-scripts',
            hookScriptName('prompt-secrets'),
          ),
        ).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'does not create .claude/ inside the project directory when -g is set',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('tok')
          .withProject('proj')
          .start();
        harness.withAuth(server.baseUrl(), 'tok');
        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
        );

        await harness.run('integrate claude -g --non-interactive');

        // Project-level .claude/ must NOT be created
        expect(harness.cwd.exists('.claude')).toBe(false);
      },
      { timeout: 30000 },
    );

    it(
      'registers hook commands with absolute paths pointing to $HOME',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('tok')
          .withProject('proj')
          .start();
        harness.withAuth(server.baseUrl(), 'tok');
        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
        );

        await harness.run('integrate claude -g --non-interactive');

        const settings = harness.userHome.file('.claude', 'settings.json').asJson();
        const preToolPath = hookScriptPath(String(settings.hooks.PreToolUse[0].hooks[0].command));
        const promptPath = hookScriptPath(
          String(settings.hooks.UserPromptSubmit[0].hooks[0].command),
        );
        const homePath = normalizePath(harness.userHome.path);

        // Must be absolute paths rooted at harness.homeDir
        expect(isAbsolute(preToolPath)).toBe(true);
        expect(preToolPath.startsWith(homePath)).toBe(true);
        expect(isAbsolute(promptPath)).toBe(true);
        expect(promptPath.startsWith(homePath)).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'keeps existing project-level agentExtensions and adds global ones when -g is passed (CLI-148)',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('tok')
          .withProject('proj')
          .start();
        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
        );

        // Simulate state from a previous project-level integration: agentExtensions with global: false
        const projectRoot = realpathSync(harness.cwd.path);
        harness.state().withRawState(
          JSON.stringify({
            version: 1,
            config: { cliVersion: CURRENT_VERSION },
            auth: {
              isAuthenticated: true,
              connections: [
                {
                  id: 'conn-1',
                  type: 'on-premise',
                  serverUrl: server.baseUrl(),
                  authenticatedAt: new Date().toISOString(),
                },
              ],
              activeConnectionId: 'conn-1',
            },
            agents: {
              'claude-code': {
                configured: true,
                configuredByCliVersion: CURRENT_VERSION,
                hooks: {
                  installed: [
                    { name: 'sonar-secrets', type: 'PreToolUse' },
                    { name: 'sonar-secrets', type: 'UserPromptSubmit' },
                  ],
                },
              },
            },
            tools: { installed: [] },
            telemetry: { enabled: false },
            agentExtensions: [
              {
                id: randomUUID(),
                agentId: 'claude-code',
                projectRoot,
                global: false,
                serverUrl: server.baseUrl(),
                updatedByCliVersion: CURRENT_VERSION,
                updatedAt: new Date().toISOString(),
                kind: 'hook',
                name: 'sonar-secrets',
                hookType: 'PreToolUse',
              },
              {
                id: randomUUID(),
                agentId: 'claude-code',
                projectRoot,
                global: false,
                serverUrl: server.baseUrl(),
                updatedByCliVersion: CURRENT_VERSION,
                updatedAt: new Date().toISOString(),
                kind: 'hook',
                name: 'sonar-secrets',
                hookType: 'UserPromptSubmit',
              },
            ],
          }),
        );
        harness.state().withKeychainToken(server.baseUrl(), 'tok');

        const result = await harness.run('integrate claude -g --non-interactive');

        expect(result.exitCode).toBe(0);

        const state = harness.stateJsonFile.asJson();
        const extensions = state.agentExtensions as Array<{
          name: string;
          hookType: string;
          global: boolean;
        }>;

        // Project-level sonar-secrets hooks must still be present (not overwritten by -g run)
        const projectSecretsHooks = extensions.filter(
          (e) => e.name === 'sonar-secrets' && !e.global,
        );
        expect(projectSecretsHooks.length).toBe(2);

        // Global sonar-secrets hooks must also be added
        const globalSecretsHooks = extensions.filter((e) => e.name === 'sonar-secrets' && e.global);
        expect(globalSecretsHooks.length).toBeGreaterThan(0);

        // sonar-sqaa is always project-level, even when -g is used
        const sqaaHooks = extensions.filter((e) => e.name === 'sonar-sqaa');
        for (const hook of sqaaHooks) {
          expect(hook.global).toBe(false);
        }
      },
      { timeout: 30000 },
    );
  });
});

// ─── Argument validation ──────────────────────────────────────────────────────

// ─── Legacy state migration ────────────────────────────────────────────────────

describe.skipIf(IS_WINDOWS)('integrate claude — legacy state without agentExtensions', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'migrates old hook scripts and populates agentExtensions when upgrading from pre-registry state',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();

      const serverUrl = server.baseUrl();

      // Old state: claude-code was configured by v0.4.0 (pre-registry), hooks.installed populated,
      // no agentExtensions field
      harness.state().withRawState(
        JSON.stringify(
          {
            version: 1,
            config: { cliVersion: '0.4.0' },
            auth: {
              isAuthenticated: true,
              connections: [
                {
                  id: 'conn-1',
                  type: 'on-premise',
                  serverUrl,
                  authenticatedAt: new Date().toISOString(),
                },
              ],
              activeConnectionId: 'conn-1',
            },
            agents: {
              'claude-code': {
                configured: true,
                configuredByCliVersion: '0.4.0',
                hooks: {
                  installed: [
                    { name: 'sonar-secrets', type: 'PreToolUse' },
                    { name: 'sonar-secrets', type: 'UserPromptSubmit' },
                  ],
                },
              },
            },
            tools: { installed: [] },
            telemetry: { enabled: false },
          },
          null,
          2,
        ),
      );
      harness.state().withKeychainToken(serverUrl, 'test-token');

      // Old hook scripts — use the deprecated `sonar analyze --file` command
      const oldScript = `#!/bin/bash\noutput=$(sonar analyze --file "$file_path" 2>/dev/null)\n`;
      const pretoolScriptRel = '.claude/hooks/sonar-secrets/build-scripts/pretool-secrets.sh';
      const promptScriptRel = '.claude/hooks/sonar-secrets/build-scripts/prompt-secrets.sh';
      harness.cwd.writeFile(pretoolScriptRel, oldScript);
      harness.cwd.writeFile(promptScriptRel, oldScript);

      // Old settings.json — hook entries referencing those scripts
      harness.cwd.writeFile(
        '.claude/settings.json',
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: 'Read',
                  hooks: [{ type: 'command', command: pretoolScriptRel, timeout: 60 }],
                },
              ],
              UserPromptSubmit: [
                {
                  matcher: '*',
                  hooks: [{ type: 'command', command: promptScriptRel, timeout: 60 }],
                },
              ],
            },
          },
          null,
          2,
        ),
      );

      const result = await harness.run(`integrate claude --project my-project --non-interactive`);

      expect(result.exitCode).toBe(0);

      // Hook scripts must be rewritten to use the new subcommand
      const pretoolContent = harness.cwd.file(pretoolScriptRel).asText();
      expect(pretoolContent).toContain('sonar hook claude-pre-tool-use');
      expect(pretoolContent).not.toContain('sonar analyze');

      // settings.json must have correctly structured hook entries (relative paths, project-level)
      const settings = harness.cwd.file('.claude', 'settings.json').asJson();
      const preToolEntry = settings.hooks?.PreToolUse?.[0];
      const promptEntry = settings.hooks?.UserPromptSubmit?.[0];
      expect(preToolEntry?.matcher).toBe('Read');
      expect(preToolEntry?.hooks?.[0]).toEqual({
        type: 'command',
        command: '.claude/hooks/sonar-secrets/build-scripts/pretool-secrets.sh',
        timeout: 60,
      });
      expect(promptEntry?.matcher).toBe('*');
      expect(promptEntry?.hooks?.[0]).toEqual({
        type: 'command',
        command: '.claude/hooks/sonar-secrets/build-scripts/prompt-secrets.sh',
        timeout: 60,
      });
    },
    { timeout: 30000 },
  );
});

// ─── CLI-137: global install over old project-level state ─────────────────────

describe.skipIf(IS_WINDOWS)(
  'integrate claude — global install over pre-registry project-level state (CLI-137)',
  () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await TestHarness.create();
      harness.state().withSecretsBinaryInstalled();
    });

    afterEach(async () => {
      await harness.dispose();
    });

    it(
      'populates agentExtensions with global entries when upgrading from old project-level install with -g',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withProject('my-project')
          .start();

        const serverUrl = server.baseUrl();

        // Old state: project-level install at v0.4.0, hooks in hooks.installed, no agentExtensions
        harness.state().withRawState(
          JSON.stringify({
            version: 1,
            config: { cliVersion: '0.4.0' },
            auth: {
              isAuthenticated: true,
              connections: [
                {
                  id: 'conn-1',
                  type: 'on-premise',
                  serverUrl,
                  authenticatedAt: new Date().toISOString(),
                },
              ],
              activeConnectionId: 'conn-1',
            },
            agents: {
              'claude-code': {
                configured: true,
                configuredByCliVersion: '0.4.0',
                hooks: {
                  installed: [
                    {
                      name: 'sonar-secrets',
                      type: 'PreToolUse',
                      installedAt: new Date().toISOString(),
                    },
                    {
                      name: 'sonar-secrets',
                      type: 'UserPromptSubmit',
                      installedAt: new Date().toISOString(),
                    },
                  ],
                },
                skills: { installed: [] },
              },
            },
            tools: { installed: [] },
            telemetry: { enabled: false, firstUseDate: new Date().toISOString(), events: [] },
          }),
        );
        harness.state().withKeychainToken(serverUrl, 'test-token');

        // Old hook scripts at project level (pre-registry location)
        const oldScript = `#!/bin/bash\noutput=$(sonar analyze --file "$file_path" 2>/dev/null)\n`;
        harness.cwd.writeFile(
          '.claude/hooks/sonar-secrets/build-scripts/pretool-secrets.sh',
          oldScript,
        );
        harness.cwd.writeFile(
          '.claude/hooks/sonar-secrets/build-scripts/prompt-secrets.sh',
          oldScript,
        );

        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${serverUrl}`, 'sonar.projectKey=my-project'].join('\n'),
        );

        const result = await harness.run('integrate claude -g --non-interactive');

        expect(result.exitCode).toBe(0);

        const state = harness.stateJsonFile.asJson();
        const extensions = state.agentExtensions as Array<{
          name: string;
          hookType: string;
          global: boolean;
          projectRoot: string;
        }>;

        // Global sonar-secrets hooks MUST be in agentExtensions
        const globalSecretsHooks = extensions.filter(
          (e) => e.name === 'sonar-secrets' && e.global === true,
        );
        expect(globalSecretsHooks.length).toBeGreaterThan(0);
        expect(globalSecretsHooks.some((h) => h.hookType === 'PreToolUse')).toBe(true);
        expect(globalSecretsHooks.some((h) => h.hookType === 'UserPromptSubmit')).toBe(true);
      },
      { timeout: 30000 },
    );
  },
);

// ─── Post-update migration ─────────────────────────────────────────────────────

describe.skipIf(IS_WINDOWS)('post-update migration — hook script rewrite on CLI upgrade', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'rewrites old hook scripts on first run after CLI upgrade (pre-registry state)',
    async () => {
      // Old state: configured by v0.4.0, no agentExtensions field (pre-registry)
      harness.state().withRawState(
        JSON.stringify(
          {
            version: 1,
            config: { cliVersion: '0.4.0' },
            auth: { isAuthenticated: false, connections: [], activeConnectionId: null },
            agents: {
              'claude-code': {
                configured: true,
                configuredByCliVersion: '0.4.0',
                hooks: { installed: [] },
              },
            },
            tools: { installed: [] },
            telemetry: { enabled: false },
          },
          null,
          2,
        ),
      );

      // Old global hook scripts in homedir (pre-registry fallback location)
      const oldScript = `#!/bin/bash\noutput=$(sonar analyze --file "$file_path" 2>/dev/null)\n`;
      const pretoolScriptRel = '.claude/hooks/sonar-secrets/build-scripts/pretool-secrets.sh';
      const promptScriptRel = '.claude/hooks/sonar-secrets/build-scripts/prompt-secrets.sh';
      harness.userHome.writeFile(pretoolScriptRel, oldScript);
      harness.userHome.writeFile(promptScriptRel, oldScript);

      // Old settings.json in homedir — hook entries referencing those scripts
      harness.userHome.writeFile(
        '.claude/settings.json',
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: 'Read',
                  hooks: [{ type: 'command', command: pretoolScriptRel, timeout: 60 }],
                },
              ],
              UserPromptSubmit: [
                {
                  matcher: '*',
                  hooks: [{ type: 'command', command: promptScriptRel, timeout: 60 }],
                },
              ],
            },
          },
          null,
          2,
        ),
      );

      // Run any CLI command — post-update fires automatically when cliVersion < current
      const result = await harness.run('--version');

      expect(result.exitCode).toBe(0);

      // Scripts must be rewritten with the new subcommand
      const pretoolContent = harness.userHome.file(pretoolScriptRel).asText();
      expect(pretoolContent).toContain('sonar hook claude-pre-tool-use');
      expect(pretoolContent).not.toContain('sonar analyze');

      // settings.json must have correctly structured hook entries (absolute paths, global)
      const settings = harness.userHome.file('.claude', 'settings.json').asJson();
      const preToolEntry = settings.hooks?.PreToolUse?.[0];
      const promptEntry = settings.hooks?.UserPromptSubmit?.[0];
      expect(preToolEntry?.matcher).toBe('Read');
      expect(preToolEntry?.hooks?.[0]).toEqual({
        type: 'command',
        command: harness.userHome.file(pretoolScriptRel).path,
        timeout: 60,
      });
      expect(promptEntry?.matcher).toBe('*');
      expect(promptEntry?.hooks?.[0]).toEqual({
        type: 'command',
        command: harness.userHome.file(promptScriptRel).path,
        timeout: 60,
      });
    },
    { timeout: 30000 },
  );
});

describe('integrate — argument validation', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 when an unsupported tool argument is provided',
    async () => {
      const result = await harness.run('integrate gemini');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain("error: unknown command 'gemini'");
    },
    { timeout: 15000 },
  );
});

// ─── sonar-secrets auto-install ───────────────────────────────────────────────

describe('integrate claude — sonar-secrets auto-install', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'downloads and installs sonar-secrets when binary is not present',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      await harness.newFakeBinariesServer().start();
      harness.withAuth(server.baseUrl(), 'test-token');
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(harness.cliHome.file('bin', buildLocalBinaryName(detectPlatform())).exists()).toBe(
        true,
      );
    },
    { timeout: 30000 },
  );

  it(
    'aborts integration when sonar-secrets download fails',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      await harness.newFakeBinariesServer().noArtifacts().start();
      harness.withAuth(server.baseUrl(), 'test-token');
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive');

      expect(result.exitCode).not.toBe(0);
      expect(harness.cliHome.file('bin', 'sonar-secrets').exists()).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'skips download when sonar-secrets is already installed at the correct version',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      harness.state().withSecretsBinaryInstalled();
      const fakeBinariesServer = await harness.newFakeBinariesServer().start();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(fakeBinariesServer.getRecordedRequests()).toHaveLength(0);
    },
    { timeout: 30000 },
  );
});

// ─── Hook migration scenarios ─────────────────────────────────────────────────

describe('integrate claude — hook migration scenarios', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    await harness.newFakeBinariesServer().start();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function setupAndRun(serverUrl: string, token: string): Promise<void> {
    harness.withAuth(serverUrl, token);
    harness.state().withSecretsBinaryInstalled();
    harness.cwd.writeFile(
      'sonar-project.properties',
      [`sonar.host.url=${serverUrl}`, 'sonar.projectKey=my-project'].join('\n'),
    );
    await harness.run('integrate claude --non-interactive');
  }

  it(
    'scenario A: fresh install writes thin launcher scripts',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('p').start();

      await setupAndRun(server.baseUrl(), 'tok');

      const preToolContent = harness.cwd
        .file(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          hookScriptName('pretool-secrets'),
        )
        .asText();
      const promptContent = harness.cwd
        .file(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          hookScriptName('prompt-secrets'),
        )
        .asText();
      expect(preToolContent).toContain('sonar hook claude-pre-tool-use');
      expect(preToolContent).not.toContain('sonar analyze');
      expect(promptContent).toContain('sonar hook claude-prompt-submit');
      expect(promptContent).not.toContain('sonar analyze');
    },
    { timeout: 30000 },
  );

  it(
    'scenario B: old fat scripts are overwritten with thin launchers',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('p').start();
      // Simulate old-style scripts that contained embedded business logic
      harness.cwd.writeFile(
        `.claude/hooks/sonar-secrets/build-scripts/${hookScriptName('pretool-secrets')}`,
        '#!/bin/bash\nsonar analyze secrets --file "$INPUT_FILE"\n',
      );
      harness.cwd.writeFile(
        `.claude/hooks/sonar-secrets/build-scripts/${hookScriptName('prompt-secrets')}`,
        '#!/bin/bash\nsonar analyze secrets --stdin\n',
      );

      await setupAndRun(server.baseUrl(), 'tok');

      const preToolContent = harness.cwd
        .file(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          hookScriptName('pretool-secrets'),
        )
        .asText();
      expect(preToolContent).toContain('sonar hook claude-pre-tool-use');
      expect(preToolContent).not.toContain('sonar analyze');
    },
    { timeout: 30000 },
  );

  it(
    'scenario C: running integrate twice is idempotent — no duplicate hook entries',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('p').start();

      await setupAndRun(server.baseUrl(), 'tok');
      await harness.run('integrate claude --non-interactive');

      const settings = harness.cwd.file('.claude', 'settings.json').asJson() as {
        hooks?: Record<string, unknown[]>;
      };
      expect(settings.hooks?.PreToolUse).toHaveLength(1);
      expect(settings.hooks?.UserPromptSubmit).toHaveLength(1);
    },
    { timeout: 30000 },
  );

  it(
    'scenario D: unrelated hooks in settings.json are preserved after re-integration',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('p').start();
      harness.cwd.writeFile(
        '.claude/settings.json',
        JSON.stringify({
          hooks: {
            PostToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'echo ran', timeout: 60 }],
              },
            ],
          },
        }),
      );

      await setupAndRun(server.baseUrl(), 'tok');

      const settings = harness.cwd.file('.claude', 'settings.json').asJson() as {
        hooks?: { PostToolUse?: Array<{ matcher: string }> };
      };
      const bashEntry = settings.hooks?.PostToolUse?.find((e) => e.matcher === 'Bash');
      expect(bashEntry).toBeDefined();
    },
    { timeout: 30000 },
  );
});
