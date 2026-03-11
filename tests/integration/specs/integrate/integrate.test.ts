/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { isAbsolute } from 'node:path';
import { TestHarness } from '../../harness';

describe('integrate claude', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  // --- Without --non-interactive (auth succeeds, no repair triggered) ---

  it(
    'performs full integration with valid --token and URL from sonar-project.properties',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      const result = await harness.run('integrate claude --token test-token --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.exists('.claude', 'settings.json')).toBe(true);
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          'pretool-secrets.sh',
        ),
      ).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'uses SONAR_CLI_TOKEN + SONAR_CLI_SERVER env vars for full integration',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('env-token')
        .withProject('env-project')
        .start();

      // sonar-project.properties has only the project key — no sonar.host.url,
      // so the server URL must come exclusively from SONAR_CLI_SERVER env var
      harness.cwd.writeFile('sonar-project.properties', 'sonar.projectKey=env-project');

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONAR_CLI_TOKEN: 'env-token',
          SONAR_CLI_SERVER: server.baseUrl(),
        },
      });

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.exists('.claude', 'settings.json')).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'uses keychain token for full integration when no --token flag is provided',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('keychain-token')
        .withProject('keychain-project')
        .start();
      harness.state().withKeychainToken(server.baseUrl(), 'keychain-token');
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
      harness.cwd.writeFile('sonar-project.properties', `sonar.host.url=${server.baseUrl()}`);

      const result = await harness.run('integrate claude --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          'pretool-secrets.sh',
        ),
      ).toBe(true);
    },
    { timeout: 30000 },
  );

  // --- Without --non-interactive (interactive browser auth via browserToken) ---

  it(
    'performs full integration via browser auth when no token is initially available',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('browser-token')
        .withProject('browser-project')
        .start();

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
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=repair-project'].join('\n'),
      );

      const result = await harness.run('integrate claude --token invalid-token', {
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
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      const result = await harness.run('integrate claude --token wrong-token --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          'pretool-secrets.sh',
        ),
      ).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'installs hooks when no token and --non-interactive',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('some-token')
        .withProject('my-project')
        .start();
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
          'pretool-secrets.sh',
        ),
      ).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'does not open browser when env vars are set but token is invalid (env vars imply non-interactive)',
    async () => {
      // Regression test: when SONAR_CLI_TOKEN + SONAR_CLI_SERVER are set but the token is
      // rejected by the server, the command must NOT open a browser — env vars imply CI/automated
      // context. Without the fix this test hangs (browser auth is triggered, loopback server waits).
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-token') // server only accepts 'valid-token'
        .withProject('my-project')
        .start();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      const result = await harness.run(
        'integrate claude', // no --non-interactive flag
        {
          extraEnv: {
            SONAR_CLI_TOKEN: 'invalid-token', // rejected by server → tokenValid = false
            SONAR_CLI_SERVER: server.baseUrl(),
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
          'pretool-secrets.sh',
        ),
      ).toBe(true);
    },
    { timeout: 15000 },
  );

  it(
    'warns about missing SONAR_CLI_SERVER when only SONAR_CLI_TOKEN is set',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('some-token')
        .withProject('my-project')
        .start();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: { SONAR_CLI_TOKEN: 'some-token' },
      });

      expect(result.exitCode).toBe(0);
      // warn() outputs to stderr
      expect(result.stderr).toContain('SONAR_CLI_SERVER');
    },
    { timeout: 30000 },
  );

  it(
    'uses --server flag URL and overrides sonar-project.properties URL',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();

      const result = await harness.run(
        `integrate claude --token test-token --server ${server.baseUrl()} --non-interactive`,
      );

      expect(result.exitCode).toBe(0);
      const requests = server.getRecordedRequests();
      expect(requests.length).toBeGreaterThan(0);
    },
    { timeout: 30000 },
  );

  it(
    'performs full integration using --token, --server, and --project flags without sonar-project.properties',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('flag-token')
        .withProject('flag-project')
        .start();

      const result = await harness.run(
        `integrate claude --token flag-token --server ${server.baseUrl()} --project flag-project --non-interactive`,
      );

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
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      const result = await harness.run('integrate claude --token test-token --non-interactive');

      expect(result.exitCode).toBe(0);
      const claudeSettingsFile = harness.cwd.file('.claude', 'settings.json');
      expect(claudeSettingsFile.exists()).toBe(true);
      const settings = claudeSettingsFile.asJson();
      expect(settings.hooks?.PreToolUse).toBeDefined();
    },
    { timeout: 30000 },
  );

  it(
    'pretool-secrets.sh exists and is executable after integration',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      await harness.run('integrate claude --token test-token --non-interactive');

      const preToolScriptFile = harness.cwd.file(
        '.claude',
        'hooks',
        'sonar-secrets',
        'build-scripts',
        'pretool-secrets.sh',
      );
      expect(preToolScriptFile.exists()).toBe(true);
      expect(preToolScriptFile.isExecutable).toBe(true);
    },
    { timeout: 30000 },
  );
});

// ─── A3S entitlement guard ────────────────────────────────────────────────────

describe('integrate claude — A3S entitlement guard', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'installs PostToolUse A3S hook when Cloud org has A3S entitlement (repair path)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('cloud-token')
        .withOrganizations([{ key: 'my-org', name: 'My Org' }])
        .withA3sEntitlement('my-org', 'test-uuid-1234')
        .withProject('my-project')
        .start();

      // Point both Cloud URL constants at the fake server so SONARCLOUD_HOSTNAME check passes
      // and getOrganizationId / checkA3sEntitlement hit the same fake server
      const serverUrl = server.baseUrl();

      const result = await harness.run(
        `integrate claude --token cloud-token --server ${serverUrl} --org my-org --project my-project --non-interactive`,
        {
          extraEnv: {
            SONAR_CLI_SONARCLOUD_URL: serverUrl,
            SONAR_CLI_SONARCLOUD_API_URL: serverUrl,
          },
        },
      );

      expect(result.exitCode).toBe(0);
      const settings = harness.cwd.file('.claude', 'settings.json').asJson();
      expect(settings.hooks?.PostToolUse).toBeDefined();
      expect(
        harness.cwd.exists('.claude', 'hooks', 'sonar-a3s', 'build-scripts', 'posttool-a3s.sh'),
      ).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'does not install PostToolUse A3S hook when org has no A3S entitlement (repair path)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('cloud-token')
        .withOrganizations([{ key: 'my-org', name: 'My Org' }])
        .withA3sEntitlement('my-org', 'test-uuid-1234', { eligible: false, enabled: false })
        .start();

      const serverUrl = server.baseUrl();

      const result = await harness.run(
        `integrate claude --token cloud-token --server ${serverUrl} --org my-org --non-interactive`,
        {
          extraEnv: {
            SONAR_CLI_SONARCLOUD_URL: serverUrl,
            SONAR_CLI_SONARCLOUD_API_URL: serverUrl,
          },
        },
      );

      expect(result.exitCode).toBe(0);
      const settings = harness.cwd.file('.claude', 'settings.json').asJson();
      expect(settings.hooks?.PostToolUse).toBeUndefined();
      expect(
        harness.cwd.exists('.claude', 'hooks', 'sonar-a3s', 'build-scripts', 'posttool-a3s.sh'),
      ).toBe(false);
    },
    { timeout: 30000 },
  );
});

// ─── Local vs Global file placement ──────────────────────────────────────────

describe('integrate claude — file placement (local vs global)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
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
        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
        );

        const result = await harness.run('integrate claude --token tok --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists('.claude', 'settings.json')).toBe(true);
        expect(
          harness.cwd.exists(
            '.claude',
            'hooks',
            'sonar-secrets',
            'build-scripts',
            'pretool-secrets.sh',
          ),
        ).toBe(true);
        expect(
          harness.cwd.exists(
            '.claude',
            'hooks',
            'sonar-secrets',
            'build-scripts',
            'prompt-secrets.sh',
          ),
        ).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'does not touch the global dir when running without -g',
      async () => {
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
        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
        );

        await harness.run('integrate claude --token tok --non-interactive');

        const settings = harness.cwd.file('.claude', 'settings.json').asJson();
        const preToolCmd = settings.hooks.PreToolUse[0].hooks[0].command as string;
        const promptCmd = settings.hooks.UserPromptSubmit[0].hooks[0].command as string;

        // Must be relative (not absolute) so they resolve from the project root
        expect(isAbsolute(preToolCmd)).toBe(false);
        expect(preToolCmd.startsWith('.claude')).toBe(true);
        expect(isAbsolute(promptCmd)).toBe(false);
        expect(promptCmd.startsWith('.claude')).toBe(true);
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
        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
        );

        const result = await harness.run('integrate claude -g --token tok --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.userHome.exists('.claude', 'settings.json')).toBe(true);
        expect(
          harness.userHome.exists(
            '.claude',
            'hooks',
            'sonar-secrets',
            'build-scripts',
            'pretool-secrets.sh',
          ),
        ).toBe(true);
        expect(
          harness.userHome.exists(
            '.claude',
            'hooks',
            'sonar-secrets',
            'build-scripts',
            'prompt-secrets.sh',
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

        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
        );

        await harness.run('integrate claude -g --token tok --non-interactive');

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
        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
        );

        await harness.run('integrate claude -g --non-interactive');

        const settings = harness.userHome.file('.claude', 'settings.json').asJson();
        const preToolCmd = settings.hooks.PreToolUse[0].hooks[0].command as string;
        const promptCmd = settings.hooks.UserPromptSubmit[0].hooks[0].command as string;

        // Must be absolute paths rooted at harness.homeDir
        expect(isAbsolute(preToolCmd)).toBe(true);
        expect(preToolCmd.startsWith(harness.userHome.path)).toBe(true);
        expect(isAbsolute(promptCmd)).toBe(true);
        expect(promptCmd.startsWith(harness.userHome.path)).toBe(true);
      },
      { timeout: 30000 },
    );
  });
});

// ─── Argument validation ──────────────────────────────────────────────────────

// ─── Legacy state migration ────────────────────────────────────────────────────

describe('integrate claude — legacy state without agentExtensions', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
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
                  keystoreKey: `sonarqube-cli:${serverUrl}`,
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

      const result = await harness.run(
        `integrate claude --token test-token --server ${serverUrl} --project my-project --non-interactive`,
      );

      expect(result.exitCode).toBe(0);

      // Hook scripts must be rewritten to use the new subcommand
      const pretoolContent = harness.cwd.file(pretoolScriptRel).asText();
      expect(pretoolContent).toContain('sonar analyze secrets --file');
      expect(pretoolContent).not.toContain('sonar analyze --file');

      // settings.json must retain PreToolUse + UserPromptSubmit entries
      const settings = harness.cwd.file('.claude', 'settings.json').asJson();
      expect(settings.hooks?.PreToolUse).toBeDefined();
      expect(settings.hooks?.UserPromptSubmit).toBeDefined();
    },
    { timeout: 30000 },
  );
});

// ─── Post-update migration ─────────────────────────────────────────────────────

describe('post-update migration — hook script rewrite on CLI upgrade', () => {
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
      expect(pretoolContent).toContain('sonar analyze secrets --file');
      expect(pretoolContent).not.toContain('sonar analyze --file');

      // settings.json must retain hook entries after migration
      const settings = harness.userHome.file('.claude', 'settings.json').asJson();
      expect(settings.hooks?.PreToolUse).toBeDefined();
      expect(settings.hooks?.UserPromptSubmit).toBeDefined();
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
