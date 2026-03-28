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

// Integration tests for `sonar integrate codex`
//
// Layout targets OpenAI Codex docs:
// - Hooks: https://developers.openai.com/codex/hooks (hooks.json next to config, [features] codex_hooks)
// - MCP: https://developers.openai.com/codex/mcp ([mcp_servers.<name>] STDIO shape)

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { TestHarness } from '../../harness';
import { version as CURRENT_VERSION } from '../../../../package.json';
import { detectPlatform } from '../../../../src/lib/platform-detector.js';
import { buildLocalBinaryName } from '../../../../src/cli/commands/_common/install/secrets.js';
import { CODEX_AGENT_DIR_NAME } from '../../../../src/lib/config-constants';
import { hasSonarqubeMcpBlockInToml } from '../../../../src/cli/commands/integrate/codex/codex-config';

const CODEX_HOOKS_DIR_NAME = 'hooks';
const CODEX_CONFIG_FILE = 'config.toml';
const CODEX_SONAR_SECRETS_HOOKS_DIR_NAME = 'sonar-secrets';
const codexHooksJsonRelPath = `${CODEX_AGENT_DIR_NAME}/hooks.json`;
const codexSecretsPretoolRelPath = `${CODEX_AGENT_DIR_NAME}/${CODEX_HOOKS_DIR_NAME}/${CODEX_SONAR_SECRETS_HOOKS_DIR_NAME}/build-scripts/pretool-secrets.sh`;
const codexSecretsPromptRelPath = `${CODEX_AGENT_DIR_NAME}/${CODEX_HOOKS_DIR_NAME}/${CODEX_SONAR_SECRETS_HOOKS_DIR_NAME}/build-scripts/prompt-secrets.sh`;
const codexA3sPosttoolRelPath = `${CODEX_AGENT_DIR_NAME}/${CODEX_HOOKS_DIR_NAME}/sonar-a3s/build-scripts/posttool-a3s.sh`;

describe('integrate codex', () => {
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

      const result = await harness.run('integrate codex --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.exists(CODEX_AGENT_DIR_NAME, CODEX_CONFIG_FILE)).toBe(true);
      expect(harness.cwd.exists(CODEX_AGENT_DIR_NAME, 'hooks.json')).toBe(true);
      expect(
        harness.cwd.exists(
          CODEX_AGENT_DIR_NAME,
          CODEX_HOOKS_DIR_NAME,
          CODEX_SONAR_SECRETS_HOOKS_DIR_NAME,
          'build-scripts',
          'pretool-secrets.sh',
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

      const result = await harness.run('integrate codex --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_TOKEN: 'env-token',
          SONARQUBE_CLI_SERVER: server.baseUrl(),
        },
      });

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.exists(CODEX_AGENT_DIR_NAME, CODEX_CONFIG_FILE)).toBe(true);
      expect(harness.cwd.exists(CODEX_AGENT_DIR_NAME, 'hooks.json')).toBe(true);
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

      const result = await harness.run('integrate codex --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.exists(CODEX_AGENT_DIR_NAME, CODEX_CONFIG_FILE)).toBe(true);
      expect(harness.cwd.exists(CODEX_AGENT_DIR_NAME, 'hooks.json')).toBe(true);
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

      const result = await harness.run('integrate codex --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(
        harness.cwd.exists(
          CODEX_AGENT_DIR_NAME,
          CODEX_HOOKS_DIR_NAME,
          CODEX_SONAR_SECRETS_HOOKS_DIR_NAME,
          'build-scripts',
          'pretool-secrets.sh',
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

      const result = await harness.run('integrate codex', {
        browserToken: 'browser-token',
      });

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.exists(CODEX_AGENT_DIR_NAME, CODEX_CONFIG_FILE)).toBe(true);
      expect(harness.cwd.exists(CODEX_AGENT_DIR_NAME, 'hooks.json')).toBe(true);
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

      const result = await harness.run('integrate codex', {
        browserToken: 'valid-browser-token',
      });

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.exists(CODEX_AGENT_DIR_NAME, CODEX_CONFIG_FILE)).toBe(true);
      expect(harness.cwd.exists(CODEX_AGENT_DIR_NAME, 'hooks.json')).toBe(true);
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

      const result = await harness.run('integrate codex --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(
        harness.cwd.exists(
          CODEX_AGENT_DIR_NAME,
          CODEX_HOOKS_DIR_NAME,
          CODEX_SONAR_SECRETS_HOOKS_DIR_NAME,
          'build-scripts',
          'pretool-secrets.sh',
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

      const result = await harness.run('integrate codex --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(
        harness.cwd.exists(
          CODEX_AGENT_DIR_NAME,
          CODEX_HOOKS_DIR_NAME,
          CODEX_SONAR_SECRETS_HOOKS_DIR_NAME,
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
        'integrate codex', // no --non-interactive flag
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
          CODEX_AGENT_DIR_NAME,
          CODEX_HOOKS_DIR_NAME,
          CODEX_SONAR_SECRETS_HOOKS_DIR_NAME,
          'build-scripts',
          'pretool-secrets.sh',
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

      const result = await harness.run('integrate codex --non-interactive', {
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

      const result = await harness.run('integrate codex --non-interactive');

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

      const result = await harness.run(`integrate codex --project flag-project --non-interactive`);

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.exists(CODEX_AGENT_DIR_NAME, CODEX_CONFIG_FILE)).toBe(true);
      expect(harness.cwd.exists(CODEX_AGENT_DIR_NAME, 'hooks.json')).toBe(true);

      const toml = harness.cwd.file(CODEX_AGENT_DIR_NAME, CODEX_CONFIG_FILE).asText();
      expect(toml).toContain('codex_hooks = true');
      if (hasSonarqubeMcpBlockInToml(toml)) {
        expect(toml).toContain('SONARQUBE_PROJECT_KEY = "flag-project"');
      }

      const componentShow = server
        .getRecordedRequests()
        .find((r) => r.path === '/api/components/show' && r.query.component === 'flag-project');
      expect(componentShow).toBeDefined();
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

      const result = await harness.run('integrate codex --non-interactive');

      expect(result.exitCode).toBe(0);
      const codexHooksFile = harness.cwd.file(CODEX_AGENT_DIR_NAME, 'hooks.json');
      expect(codexHooksFile.exists()).toBe(true);
      const hooksJson = codexHooksFile.asJson();
      expect(hooksJson.hooks?.PreToolUse).toBeDefined();
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
      harness.withAuth(server.baseUrl(), 'test-token');
      harness.state().withSecretsBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      await harness.run('integrate codex --non-interactive');

      const preToolScriptFile = harness.cwd.file(
        CODEX_AGENT_DIR_NAME,
        CODEX_HOOKS_DIR_NAME,
        CODEX_SONAR_SECRETS_HOOKS_DIR_NAME,
        'build-scripts',
        'pretool-secrets.sh',
      );
      expect(preToolScriptFile.exists()).toBe(true);
      expect(preToolScriptFile.isExecutable).toBe(true);
    },
    { timeout: 30000 },
  );
  it(
    'prompt-secrets.sh uses correct subcommand (sonar analyze secrets) after integration',
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

      await harness.run('integrate codex --non-interactive');

      const promptScriptContent = harness.cwd
        .file(
          CODEX_AGENT_DIR_NAME,
          CODEX_HOOKS_DIR_NAME,
          CODEX_SONAR_SECRETS_HOOKS_DIR_NAME,
          'build-scripts',
          'prompt-secrets.sh',
        )
        .asText();
      expect(promptScriptContent).toContain('analyze secrets');
      expect(promptScriptContent).not.toContain('sonar analyze --file');
    },
    { timeout: 30000 },
  );

  it(
    'exits with code 1 and prompts to authenticate when no auth is configured',
    async () => {
      const result = await harness.run('integrate codex --non-interactive');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        '❌ Not authenticated. Run: sonar auth login',
      );
    },
    { timeout: 15000 },
  );
});

// ─── OpenAI Codex docs (hooks + MCP) ───────────────────────────────────────────

describe('integrate codex — OpenAI Codex hooks & MCP docs', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    await harness.newFakeBinariesServer().start();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'writes hooks.json + config.toml consistent with developers.openai.com/codex/hooks and /mcp',
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
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${serverUrl}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      const result = await harness.run(`integrate codex --project my-project --non-interactive`, {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);

      // hooks.json next to .codex/config.toml (https://developers.openai.com/codex/hooks)
      expect(harness.cwd.exists(CODEX_AGENT_DIR_NAME, 'hooks.json')).toBe(true);
      expect(harness.cwd.exists(CODEX_AGENT_DIR_NAME, CODEX_CONFIG_FILE)).toBe(true);

      const settings = harness.cwd.file(CODEX_AGENT_DIR_NAME, 'hooks.json').asJson() as {
        hooks?: Record<
          string,
          Array<{
            matcher: string;
            hooks: Array<{
              type: string;
              command: string;
              timeout?: number;
              statusMessage?: string;
            }>;
          }>
        >;
      };

      // PreToolUse / PostToolUse: matcher filters tool_name; runtime currently only emits Bash.
      const pre = settings.hooks?.PreToolUse?.[0];
      expect(pre?.matcher).toBe('Bash');
      const preHook = pre?.hooks?.[0];
      expect(preHook?.type).toBe('command');
      expect(typeof preHook?.timeout).toBe('number');
      expect(isAbsolute(preHook?.command ?? '')).toBe(true);

      const postGroups = settings.hooks?.PostToolUse ?? [];
      const sqaaGroup = postGroups.find((g) =>
        g.hooks.some((h) => h.command.includes('sonar-sqaa')),
      );
      expect(sqaaGroup?.matcher).toBe('Bash');
      const sqaaHook = sqaaGroup?.hooks.find((h) => h.command.includes('sonar-sqaa'));
      expect(sqaaHook?.type).toBe('command');
      expect(typeof sqaaHook?.timeout).toBe('number');
      expect(isAbsolute(sqaaHook?.command ?? '')).toBe(true);

      // UserPromptSubmit: matcher is ignored at runtime; we still use "*" to match all prompts.
      const ups = settings.hooks?.UserPromptSubmit?.[0];
      expect(ups?.hooks?.[0]?.type).toBe('command');
      expect(isAbsolute(ups?.hooks?.[0]?.command ?? '')).toBe(true);

      const toml = harness.cwd.file(CODEX_AGENT_DIR_NAME, CODEX_CONFIG_FILE).asText();
      // Hooks require [features] codex_hooks = true (same page).
      expect(toml).toContain('codex_hooks = true');

      // STDIO MCP server tables (https://developers.openai.com/codex/mcp) when Docker wrote MCP.
      if (hasSonarqubeMcpBlockInToml(toml)) {
        expect(toml).toMatch(/^\[mcp_servers\.sonarqube\]\s*$/m);
        expect(toml).toMatch(/^command\s*=\s*"/m);
        expect(toml).toMatch(/^args\s*=\s*\[/m);
        expect(toml).toContain('[mcp_servers.sonarqube.env]');
        expect(toml).toContain('SONARQUBE_PROJECT_KEY = "my-project"');
      }
    },
    { timeout: 30000 },
  );
});

// ─── SQAA entitlement guard ────────────────────────────────────────────────────

describe('integrate codex — SQAA entitlement guard', () => {
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

      const result = await harness.run(`integrate codex --project my-project --non-interactive`, {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const settings = harness.cwd.file(CODEX_AGENT_DIR_NAME, 'hooks.json').asJson();
      expect(settings.hooks?.PostToolUse).toBeDefined();
      expect(
        harness.cwd.exists(
          CODEX_AGENT_DIR_NAME,
          CODEX_HOOKS_DIR_NAME,
          'sonar-sqaa',
          'build-scripts',
          'posttool-sqaa.sh',
        ),
      ).toBe(true);
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

      const result = await harness.run(`integrate codex --non-interactive`, {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const settings = harness.cwd.file(CODEX_AGENT_DIR_NAME, 'hooks.json').asJson();
      expect(settings.hooks?.PostToolUse).toBeUndefined();
      expect(
        harness.cwd.exists(
          CODEX_AGENT_DIR_NAME,
          CODEX_HOOKS_DIR_NAME,
          'sonar-sqaa',
          'build-scripts',
          'posttool-sqaa.sh',
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
        `integrate codex -g --project my-project --non-interactive`,
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
      harness.cwd.writeFile(codexA3sPosttoolRelPath, '#!/bin/bash\necho old');
      harness.cwd.writeFile(
        codexHooksJsonRelPath,
        JSON.stringify({
          hooks: {
            PostToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  {
                    type: 'command',
                    command: codexA3sPosttoolRelPath,
                    timeout: 60,
                  },
                ],
              },
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: `${CODEX_AGENT_DIR_NAME}/hooks/some-other-tool/run.sh`,
                    timeout: 30,
                  },
                ],
              },
            ],
          },
        }),
      );

      const result = await harness.run(`integrate codex --project my-project --non-interactive`, {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const settings = harness.cwd.file(CODEX_AGENT_DIR_NAME, 'hooks.json').asJson();
      const postToolUseCommands = (
        settings.hooks?.PostToolUse as Array<{ hooks: Array<{ command: string }> }>
      )?.flatMap((e) => e.hooks.map((h) => h.command));
      expect(postToolUseCommands?.some((c: string) => c.includes('sonar-a3s'))).toBe(false);
      expect(postToolUseCommands?.some((c: string) => c.includes('sonar-sqaa'))).toBe(true);
      expect(postToolUseCommands?.some((c: string) => c.includes('some-other-tool'))).toBe(true);
      expect(harness.cwd.exists(CODEX_AGENT_DIR_NAME, CODEX_HOOKS_DIR_NAME, 'sonar-a3s')).toBe(
        false,
      );
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
              keystoreKey: `sonarqube-cli:${serverUrl}:my-org`,
            },
          ],
          activeConnectionId: 'test-conn',
        },
        agents: {
          codex: {
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
            agentId: 'codex',
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

      const result = await harness.run(`integrate codex --project my-project --non-interactive`, {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);

      const state = harness.stateJsonFile.asJson();
      const extensions = state.agentExtensions as Array<{ name: string }>;
      const hooks = (state.agents?.['codex']?.hooks?.installed ?? []) as Array<{
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

describe('integrate codex — file placement (local vs global)', () => {
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
      'writes hook scripts, hooks.json, and config.toml inside projectDir/.codex/',
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

        const result = await harness.run('integrate codex --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(CODEX_AGENT_DIR_NAME, CODEX_CONFIG_FILE)).toBe(true);
        expect(harness.cwd.exists(CODEX_AGENT_DIR_NAME, 'hooks.json')).toBe(true);
        expect(
          harness.cwd.exists(
            CODEX_AGENT_DIR_NAME,
            CODEX_HOOKS_DIR_NAME,
            CODEX_SONAR_SECRETS_HOOKS_DIR_NAME,
            'build-scripts',
            'pretool-secrets.sh',
          ),
        ).toBe(true);
        expect(
          harness.cwd.exists(
            CODEX_AGENT_DIR_NAME,
            CODEX_HOOKS_DIR_NAME,
            CODEX_SONAR_SECRETS_HOOKS_DIR_NAME,
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
        harness.withAuth('http://localhost:19999', 'fake-token');
        await harness.run('integrate codex --non-interactive');

        // Global dir must be completely untouched
        expect(harness.userHome.exists(CODEX_AGENT_DIR_NAME)).toBe(false);
      },
      { timeout: 30000 },
    );

    it(
      'registers hook commands with absolute paths in project .codex/hooks.json',
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

        await harness.run('integrate codex --non-interactive');

        const settings = harness.cwd.file(CODEX_AGENT_DIR_NAME, 'hooks.json').asJson();
        const preToolCmd = settings.hooks.PreToolUse[0].hooks[0].command as string;
        const promptCmd = settings.hooks.UserPromptSubmit[0].hooks[0].command as string;

        const projectRoot = realpathSync(harness.cwd.path);
        expect(isAbsolute(preToolCmd)).toBe(true);
        expect(preToolCmd.startsWith(projectRoot)).toBe(true);
        expect(isAbsolute(promptCmd)).toBe(true);
        expect(promptCmd.startsWith(projectRoot)).toBe(true);
      },
      { timeout: 30000 },
    );
  });

  // ─── Global (-g flag) ──────────────────────────────────────────────────────

  describe('global hooks (-g flag)', () => {
    it(
      'writes hook scripts, hooks.json, and config.toml to $HOME/.codex/',
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

        const result = await harness.run('integrate codex -g --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.userHome.exists(CODEX_AGENT_DIR_NAME, CODEX_CONFIG_FILE)).toBe(true);
        expect(harness.userHome.exists(CODEX_AGENT_DIR_NAME, 'hooks.json')).toBe(true);
        expect(
          harness.userHome.exists(
            CODEX_AGENT_DIR_NAME,
            CODEX_HOOKS_DIR_NAME,
            CODEX_SONAR_SECRETS_HOOKS_DIR_NAME,
            'build-scripts',
            'pretool-secrets.sh',
          ),
        ).toBe(true);
        expect(
          harness.userHome.exists(
            CODEX_AGENT_DIR_NAME,
            CODEX_HOOKS_DIR_NAME,
            CODEX_SONAR_SECRETS_HOOKS_DIR_NAME,
            'build-scripts',
            'prompt-secrets.sh',
          ),
        ).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'does not create .codex/ inside the project directory when -g is set',
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

        await harness.run('integrate codex -g --non-interactive');

        // Project-level .codex/ must NOT be created
        expect(harness.cwd.exists(CODEX_AGENT_DIR_NAME)).toBe(false);
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

        await harness.run('integrate codex -g --non-interactive');

        const settings = harness.userHome.file(CODEX_AGENT_DIR_NAME, 'hooks.json').asJson();
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
                  keystoreKey: `sonarqube-cli:${server.baseUrl()}`,
                },
              ],
              activeConnectionId: 'conn-1',
            },
            agents: {
              codex: {
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
                agentId: 'codex',
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
                agentId: 'codex',
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

        const result = await harness.run('integrate codex -g --non-interactive');

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

describe('integrate codex — legacy state without agentExtensions', () => {
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

      // Old state: codex was configured by v0.4.0 (pre-registry), hooks.installed populated,
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
              codex: {
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
      harness.cwd.writeFile(codexSecretsPretoolRelPath, oldScript);
      harness.cwd.writeFile(codexSecretsPromptRelPath, oldScript);

      // Old hooks.json — hook entries referencing those scripts
      harness.cwd.writeFile(
        codexHooksJsonRelPath,
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: 'Bash',
                  hooks: [{ type: 'command', command: codexSecretsPretoolRelPath, timeout: 60 }],
                },
              ],
              UserPromptSubmit: [
                {
                  matcher: '*',
                  hooks: [{ type: 'command', command: codexSecretsPromptRelPath, timeout: 60 }],
                },
              ],
            },
          },
          null,
          2,
        ),
      );

      const result = await harness.run(`integrate codex --project my-project --non-interactive`);

      expect(result.exitCode).toBe(0);

      // Hook scripts must be rewritten to use the new subcommand
      const pretoolContent = harness.cwd.file(codexSecretsPretoolRelPath).asText();
      expect(pretoolContent).toContain('analyze secrets');
      expect(pretoolContent).not.toContain('sonar analyze --file');

      // hooks.json must use absolute hook commands and Bash PreToolUse matcher (Codex)
      const settings = harness.cwd.file(CODEX_AGENT_DIR_NAME, 'hooks.json').asJson();
      const preToolEntry = settings.hooks?.PreToolUse?.[0];
      const promptEntry = settings.hooks?.UserPromptSubmit?.[0];
      expect(preToolEntry?.matcher).toBe('Bash');
      expect(preToolEntry?.hooks?.[0]).toEqual({
        type: 'command',
        command: realpathSync(harness.cwd.file(codexSecretsPretoolRelPath).path),
        timeout: 60,
        statusMessage: 'Sonar: scanning Bash command for secrets',
      });
      expect(promptEntry?.matcher).toBe('*');
      expect(promptEntry?.hooks?.[0]).toEqual({
        type: 'command',
        command: realpathSync(harness.cwd.file(codexSecretsPromptRelPath).path),
        timeout: 60,
        statusMessage: 'Sonar: scanning prompt for secrets',
      });
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
              codex: {
                configured: true,
                configuredByCliVersion: '0.4.0',
                hooks: { installed: [] },
                skills: { installed: [] },
              },
            },
            tools: { installed: [] },
            telemetry: { enabled: false, firstUseDate: new Date().toISOString(), events: [] },
          },
          null,
          2,
        ),
      );

      // Old global hook scripts in homedir (pre-registry fallback location)
      const oldScript = `#!/bin/bash\noutput=$(sonar analyze --file "$file_path" 2>/dev/null)\n`;
      harness.userHome.writeFile(codexSecretsPretoolRelPath, oldScript);
      harness.userHome.writeFile(codexSecretsPromptRelPath, oldScript);

      // Old hooks.json in homedir — hook entries referencing those scripts
      harness.userHome.writeFile(
        codexHooksJsonRelPath,
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: 'Bash',
                  hooks: [{ type: 'command', command: codexSecretsPretoolRelPath, timeout: 60 }],
                },
              ],
              UserPromptSubmit: [
                {
                  matcher: '*',
                  hooks: [{ type: 'command', command: codexSecretsPromptRelPath, timeout: 60 }],
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
      const pretoolContent = harness.userHome.file(codexSecretsPretoolRelPath).asText();
      expect(pretoolContent).toContain('analyze secrets');
      expect(pretoolContent).not.toContain('sonar analyze --file');

      // hooks.json must have absolute hook commands and Bash PreToolUse matcher (global Codex)
      const settings = harness.userHome.file(CODEX_AGENT_DIR_NAME, 'hooks.json').asJson();
      const preToolEntry = settings.hooks?.PreToolUse?.[0];
      const promptEntry = settings.hooks?.UserPromptSubmit?.[0];
      expect(preToolEntry?.matcher).toBe('Bash');
      const preHook = preToolEntry?.hooks?.[0] as { command?: string } | undefined;
      expect(preHook).toMatchObject({
        type: 'command',
        timeout: 60,
        statusMessage: 'Sonar: scanning Bash command for secrets',
      });
      expect(realpathSync(String(preHook?.command))).toBe(
        realpathSync(harness.userHome.file(codexSecretsPretoolRelPath).path),
      );
      expect(promptEntry?.matcher).toBe('*');
      const promptHook = promptEntry?.hooks?.[0] as { command?: string } | undefined;
      expect(promptHook).toMatchObject({
        type: 'command',
        timeout: 60,
        statusMessage: 'Sonar: scanning prompt for secrets',
      });
      expect(realpathSync(String(promptHook?.command))).toBe(
        realpathSync(harness.userHome.file(codexSecretsPromptRelPath).path),
      );
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

describe('integrate codex — sonar-secrets auto-install', () => {
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

      const result = await harness.run('integrate codex --non-interactive');

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

      const result = await harness.run('integrate codex --non-interactive');

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

      const result = await harness.run('integrate codex --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(fakeBinariesServer.getRecordedRequests()).toHaveLength(0);
    },
    { timeout: 30000 },
  );
});
