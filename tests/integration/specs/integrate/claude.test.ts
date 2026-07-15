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

import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildLocalBinaryName } from '../../../../src/cli/commands/_common/install/secrets.js';
import { claudeIntegration } from '../../../../src/cli/commands/integrate/claude/declaration.js';
import { detectPlatform } from '../../../../src/lib/platform-detector.js';
import {
  hookScriptName,
  hookScriptPath,
  IS_WINDOWS,
  normalizePath,
  TestHarness,
} from '../../harness';
import { findInstalledFeature, getInstalledIntegration } from './state-helpers';

function findClaudeFeature(harness: TestHarness, featureId: string, scope?: string) {
  return findInstalledFeature(harness, 'claude-code', featureId, scope);
}

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

      // Pre-install "What will be installed" summary box
      expect(result.stdout).toContain('What will be installed');

      // Completion summary
      expect(result.stdout).toContain('Installed');
      expect(result.stdout).toContain('Setup complete!');
      expect(result.stdout).toContain('secret scanning hooks');
      expect(result.stdout).toContain('paste this into Claude');
    },
    { timeout: 30000 },
  );

  it(
    'records declarative Claude features in integrations.installed for project installs',
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

      const state = harness.stateJsonFile.asJson();
      const claudeIntegration = state.integrations.installed.find(
        (integration: { integrationId: string }) => integration.integrationId === 'claude-code',
      );

      expect(claudeIntegration).toBeDefined();
      expect(
        claudeIntegration.features
          .map((feature: { featureId: string }) => feature.featureId)
          .sort(),
      ).toEqual(['mcp-server', 'sonar-secrets-hooks']);

      const secretsHooksFeature = claudeIntegration.features.find(
        (feature: { featureId: string }) => feature.featureId === 'sonar-secrets-hooks',
      );
      const mcpFeature = claudeIntegration.features.find(
        (feature: { featureId: string }) => feature.featureId === 'mcp-server',
      );
      expect(secretsHooksFeature).toMatchObject({
        scope: 'project',
        dependencies: [{ id: 'sonar-secrets' }],
        attrs: {
          projectKey: 'my-project',
        },
      });
      expect(mcpFeature).toMatchObject({
        resources: [
          {
            id: 'claude-mcp-config',
            resourceType: 'json-patch',
            path: harness.cwd.file('.mcp.json').path,
          },
        ],
        operations: [],
      });
      expect(state.dependencies.installed).toMatchObject([
        {
          id: 'sonar-secrets',
          dependencyType: 'sonarsource-binary',
        },
      ]);
    },
    { timeout: 30000 },
  );

  it(
    'fails when the existing Claude settings file contains invalid JSON',
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
      harness.cwd.writeFile('.claude/settings.json', '{ invalid json');

      const result = await harness.run('integrate claude --non-interactive');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('settings.json contains invalid JSON');
      expect(output).toContain('Please fix or delete it and re-run.');
    },
    { timeout: 30000 },
  );

  it(
    'fails when the existing Claude MCP config file contains invalid JSON',
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
      harness.cwd.writeFile('.mcp.json', '{ invalid json');

      const result = await harness.run('integrate claude --non-interactive');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('.mcp.json contains invalid JSON');
      expect(output).toContain('Please fix or delete it and re-run.');
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
    'aborts when stored token fails setup summary validation',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('browser-token')
        .withProject('browser-project')
        .start();

      harness.withAuth(server.baseUrl(), 'initial-invalid-token');
      harness.state().withSecretsBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=browser-project'].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        browserToken: 'browser-token',
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Token is invalid');
      expect(harness.cwd.exists('.claude', 'settings.json')).toBe(false);
    },
    { timeout: 30000 },
  );

  // --- With --non-interactive ---

  it(
    'aborts before installing hooks when token is invalid (--non-interactive)',
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

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Token is invalid');
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          hookScriptName('pretool-secrets'),
        ),
      ).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'aborts when token is invalid and --non-interactive (no degraded install)',
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

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Token is invalid');
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          hookScriptName('pretool-secrets'),
        ),
      ).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'does not open browser when env vars are set but token is invalid (env vars imply non-interactive)',
    async () => {
      // When SONARQUBE_CLI_TOKEN + SONARQUBE_CLI_SERVER are set but the token is rejected by the
      // server, setup summary validation fails fast without opening a browser.
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

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_TOKEN: 'invalid-token', // rejected by server
          SONARQUBE_CLI_SERVER: server.baseUrl(),
          // no browserToken: if browser auth is triggered the test times out
        },
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Token is invalid');
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          hookScriptName('pretool-secrets'),
        ),
      ).toBe(false);
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
    'quotes the hook command so it survives a project directory containing a space',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      harness.state().withSecretsBinaryInstalled();

      const spacedDir = harness.cwd.dir('dir with space', 'myproj');
      spacedDir.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        cwd: spacedDir.path,
      });

      expect(result.exitCode).toBe(0);
      const command = String(
        spacedDir.file('.claude', 'settings.json').asJson().hooks.PreToolUse[0].hooks[0].command,
      );
      // Project scope emits a relative, fully-quoted path (double quotes on
      // Windows, single quotes on Unix) — deterministic regardless of the
      // spaced project directory, so assert the exact command.
      const scriptRel = '.claude/hooks/sonar-secrets/build-scripts/pretool-secrets';
      expect(command).toBe(
        IS_WINDOWS
          ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptRel}.ps1"`
          : `'${scriptRel}.sh'`,
      );
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
      const output = result.stdout + result.stderr;
      expect(output).toContain('❌ Not authenticated.');
      expect(output).toContain("  → Run 'sonar auth login' to authenticate.");
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
      expect(harness.cwd.file('CLAUDE.md').asText()).toContain(
        '# SonarQube Agentic Analysis protocol',
      );
      expect(findClaudeFeature(harness, 'sqaa-instructions')?.scope).toBe('project');
    },
    { timeout: 30000 },
  );

  it(
    'records the project key on the declarative sonar-sqaa-hook feature after a fresh SQAA install',
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

      const sqaaFeature = findClaudeFeature(harness, 'sonar-sqaa-hook', 'project');
      expect(sqaaFeature).toBeDefined();
      expect(sqaaFeature?.attrs?.projectKey).toBe('my-project');
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
        .withSqaaEntitlement('my-org', 'test-uuid-1234', { allowed: false, hasEntitlement: false })
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
    'installs the SQAA hook and warns when the org is entitled but over its usage limit',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('cloud-token')
        .withOrganizations([{ key: 'my-org', name: 'My Org' }])
        .withSqaaEntitlement('my-org', 'test-uuid-1234', {
          allowed: false,
          hasEntitlement: true,
        })
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
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'Your organization has reached its Vortex agentic analysis usage limit',
      );
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

  it('rejects --global combined with --project', async () => {
    const server = await harness.newFakeServer().withAuthToken('cloud-token').start();
    harness.withAuth(server.baseUrl(), 'cloud-token');

    const result = await harness.run('integrate claude -g --project my-project');

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('mutually exclusive');
  });

  it(
    'skips the sonar-sqaa hook on a -g install even when the org is entitled, and warns',
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

      const result = await harness.run('integrate claude -g --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain('not supported with --global');

      expect(findClaudeFeature(harness, 'sonar-sqaa-hook')).toBeUndefined();
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

  describe('project-level install when a global Claude hook already exists', () => {
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
        expect(`${result.stdout}\n${result.stderr}`).toContain(
          'A global secrets scanning hook is already configured. Skipping project-level secrets hooks to avoid duplicate execution.',
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
      'keeps an existing project-scoped install and adds a global one when -g is passed (CLI-148)',
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

        // Simulate a previous project-level integration recorded in declarative state.
        const projectRoot = realpathSync(harness.cwd.path);
        harness
          .state()
          .withInstalledIntegrationFeature(
            claudeIntegration,
            'sonar-secrets-hooks',
            'project',
            projectRoot,
          );

        const result = await harness.run('integrate claude -g --non-interactive');

        expect(result.exitCode).toBe(0);

        // The pre-existing project-scoped feature must survive a -g run
        expect(findClaudeFeature(harness, 'sonar-secrets-hooks', 'project')).toBeDefined();

        // The global secrets-hooks feature is also recorded.
        expect(findClaudeFeature(harness, 'sonar-secrets-hooks', 'global')).toBeDefined();

        // sonar-sqaa is never installed on a -g install (it is project-scoped only)
        expect(findClaudeFeature(harness, 'sonar-sqaa-hook')).toBeUndefined();
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
    'migrates old hook scripts and normalizes settings.json when upgrading from pre-registry state',
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
      expect(preToolEntry?.hooks?.[0]?.type).toBe('command');
      expect(preToolEntry?.hooks?.[0]?.timeout).toBe(60);
      // Command is shell-quoted; compare the unquoted path.
      expect(hookScriptPath(String(preToolEntry?.hooks?.[0]?.command))).toBe(
        '.claude/hooks/sonar-secrets/build-scripts/pretool-secrets.sh',
      );
      expect(promptEntry?.matcher).toBe('*');
      expect(promptEntry?.hooks?.[0]?.type).toBe('command');
      expect(promptEntry?.hooks?.[0]?.timeout).toBe(60);
      expect(hookScriptPath(String(promptEntry?.hooks?.[0]?.command))).toBe(
        '.claude/hooks/sonar-secrets/build-scripts/prompt-secrets.sh',
      );
    },
    { timeout: 30000 },
  );
});

// ─── Post-update migration ─────────────────────────────────────────────────────

describe.skipIf(IS_WINDOWS)('post-update migration on CLI upgrade', () => {
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
      expect(preToolEntry?.hooks?.[0]?.type).toBe('command');
      expect(preToolEntry?.hooks?.[0]?.timeout).toBe(60);
      // Command is shell-quoted; compare the unquoted, normalized path.
      expect(hookScriptPath(String(preToolEntry?.hooks?.[0]?.command))).toBe(
        normalizePath(harness.userHome.file(pretoolScriptRel).path),
      );
      expect(promptEntry?.matcher).toBe('*');
      expect(promptEntry?.hooks?.[0]?.type).toBe('command');
      expect(promptEntry?.hooks?.[0]?.timeout).toBe(60);
      expect(hookScriptPath(String(promptEntry?.hooks?.[0]?.command))).toBe(
        normalizePath(harness.userHome.file(promptScriptRel).path),
      );
    },
    { timeout: 30000 },
  );

  it(
    'purges obsolete sonar-a3s entries from state.json on first run after CLI upgrade',
    async () => {
      const now = new Date().toISOString();
      // Old state: configured by v0.4.0 with sonar-a3s recorded in both the legacy
      // hooks.installed list and the agentExtensions registry, alongside unrelated
      // sonar-secrets entries that must survive the cleanup.
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
                hooks: {
                  installed: [
                    { name: 'sonar-a3s', type: 'PostToolUse', installedAt: now },
                    { name: 'sonar-secrets', type: 'PreToolUse', installedAt: now },
                  ],
                },
                skills: { installed: [] },
              },
            },
            agentExtensions: [
              {
                id: 'a3s-ext',
                agentId: 'claude-code',
                projectRoot: harness.cwd.path,
                global: false,
                kind: 'hook',
                name: 'sonar-a3s',
                hookType: 'PostToolUse',
                updatedByCliVersion: '0.4.0',
                updatedAt: now,
              },
              {
                id: 'secrets-ext',
                agentId: 'claude-code',
                projectRoot: harness.cwd.path,
                global: false,
                kind: 'hook',
                name: 'sonar-secrets',
                hookType: 'PreToolUse',
                updatedByCliVersion: '0.4.0',
                updatedAt: now,
              },
            ],
            tools: { installed: [] },
            telemetry: { enabled: false },
          },
          null,
          2,
        ),
      );

      // Run any CLI command — post-update fires automatically when cliVersion < current
      const result = await harness.run('--version');

      expect(result.exitCode).toBe(0);

      const state = harness.stateJsonFile.asJson();
      const extensions = (state.agentExtensions ?? []) as Array<{ name: string }>;
      const hooks = (state.agents?.['claude-code']?.hooks?.installed ?? []) as Array<{
        name: string;
      }>;

      // sonar-a3s is purged from both the legacy list and the registry...
      expect(hooks.some((h) => h.name === 'sonar-a3s')).toBe(false);
      expect(extensions.some((e) => e.name === 'sonar-a3s')).toBe(false);
      // ...while unrelated entries survive.
      expect(hooks.some((h) => h.name === 'sonar-secrets')).toBe(true);
      expect(extensions.some((e) => e.name === 'sonar-secrets')).toBe(true);
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
      expect(result.stdout + result.stderr).toContain("❌ error: unknown command 'gemini'");
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
    'scenario C: running integrate twice is idempotent — no duplicate hook entries or declarative features',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('p').start();

      await setupAndRun(server.baseUrl(), 'tok');
      await harness.run('integrate claude --non-interactive');

      const settings = harness.cwd.file('.claude', 'settings.json').asJson() as {
        hooks?: Record<string, unknown[]>;
      };
      expect(settings.hooks?.PreToolUse).toHaveLength(1);
      expect(settings.hooks?.UserPromptSubmit).toHaveLength(1);

      // Declarative state must not accumulate duplicate feature entries across re-runs.
      const secretsFeatures =
        getInstalledIntegration(harness, 'claude-code')?.features.filter(
          (feature) => feature.featureId === 'sonar-secrets-hooks',
        ) ?? [];
      expect(secretsFeatures).toHaveLength(1);
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

// ─── Interactive feature selection ────────────────────────────────────────────

describe('integrate claude — interactive feature selection', () => {
  const HTTP_SERVICE_UNAVAILABLE = 503;
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'prompts per feature, installs accepted features, and shows the SQAA promotion when not entitled',
    async () => {
      // On-premise auth with no org: SQAA is not available, so it is skipped
      // without a prompt but surfaces the shared promotion message. Context
      // Augmentation is skipped silently. The secret scanning hooks and MCP
      // server features each ask.
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
      );

      // '\r' selects project scope, then the hook + MCP feature prompts.
      const result = await harness.run('integrate claude', {
        stdinChunks: ['\r', '\r', '\r'],
      });

      expect(result.exitCode).toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('Install secret scanning hooks?');
      expect(output).toContain('Install MCP server?');
      // SQAA is not eligible, so it is skipped without a prompt but the shared
      // promotion message is surfaced.
      expect(output).not.toContain('Install Vortex agentic analysis hook?');
      expect(output).toContain('Vortex agentic analysis is available on SonarQube Cloud');

      // Accepted features are installed on disk.
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          hookScriptName('pretool-secrets'),
        ),
      ).toBe(true);
      expect(harness.cwd.exists('.mcp.json')).toBe(true);

      // Declarative state records only the accepted features.
      expect(findClaudeFeature(harness, 'sonar-secrets-hooks')).toBeDefined();
      expect(findClaudeFeature(harness, 'mcp-server')).toBeDefined();
      expect(findClaudeFeature(harness, 'sonar-sqaa-hook')).toBeUndefined();
    },
    { timeout: 30000 },
  );

  it(
    'skips a feature when the user declines its prompt',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
      );

      // '\r' selects project scope; decline the secret scanning hooks ('n'), accept MCP ('\r').
      const result = await harness.run('integrate claude', {
        stdinChunks: ['\r', 'n', '\r'],
      });

      expect(result.exitCode).toBe(0);
      // Hooks were declined: no hook artifacts and no state entry.
      expect(harness.cwd.exists('.claude', 'hooks', 'sonar-secrets')).toBe(false);
      expect(findClaudeFeature(harness, 'sonar-secrets-hooks')).toBeUndefined();
      // The accepted MCP feature still installs.
      expect(harness.cwd.exists('.mcp.json')).toBe(true);
      expect(findClaudeFeature(harness, 'mcp-server')).toBeDefined();
    },
    { timeout: 30000 },
  );

  it(
    'asks before installing the SQAA hook when the org is entitled and a project key is known',
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

      // '\r' selects project scope, then secrets, SQAA hook, SQAA instructions, MCP, CAG prompts.
      const result = await harness.run('integrate claude --project my-project', {
        stdinChunks: ['\r', '\r', '\r', '\r', '\r'],
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('Install Vortex agentic analysis hook?');

      // Accepting installs the PostToolUse SQAA hook script and SQAA instructions.
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-sqaa',
          'build-scripts',
          hookScriptName('posttool-sqaa'),
        ),
      ).toBe(true);
      expect(findClaudeFeature(harness, 'sonar-sqaa-hook')).toBeDefined();
      expect(harness.cwd.file('CLAUDE.md').asText()).toContain(
        '# SonarQube Agentic Analysis protocol',
      );
      expect(findClaudeFeature(harness, 'sqaa-instructions')).toBeDefined();
    },
    { timeout: 30000 },
  );

  it(
    'warns and skips SQAA when the entitlement check fails',
    async () => {
      // Cloud connection whose org/entitlement lookup errors out: resolveSqaaSetup
      // hits the 'check_failed' branch, which warns and skips silently rather than
      // surfacing the promotion.
      const server = await harness
        .newFakeServer()
        .withAuthToken('cloud-token')
        .withOrganizations([{ key: 'my-org', name: 'My Org' }])
        .withOrgsLookupError(HTTP_SERVICE_UNAVAILABLE)
        .withProject('my-project')
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, 'cloud-token', 'my-org');

      // '\r' selects project scope, then the secret scanning hooks + MCP prompts.
      // SQAA is skipped without a prompt because entitlement could not be resolved.
      const result = await harness.run('integrate claude --project my-project', {
        stdinChunks: ['\r', '\r', '\r'],
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('Could not determine Vortex agentic analysis entitlement');
      expect(output).not.toContain('Install Vortex agentic analysis hook?');
      expect(findClaudeFeature(harness, 'sonar-sqaa-hook')).toBeUndefined();
    },
    { timeout: 30000 },
  );
});

// ─── Keep / remove already-installed features on re-run ───────────────────────

describe('integrate claude — keep/remove already-installed features', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function seedInstalledFeatures(): void {
    harness
      .state()
      .withInstalledIntegrationFeature(
        claudeIntegration,
        'sonar-secrets-hooks',
        'project',
        harness.cwd.path,
      )
      .withInstalledIntegrationFeature(
        claudeIntegration,
        'mcp-server',
        'project',
        harness.cwd.path,
      );
  }

  it(
    'offers "Keep?" for installed features and uninstalls the one the user declines',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      seedInstalledFeatures();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
      );

      // Project scope, keep the hooks (default Yes), decline the MCP server ('n')
      // then confirm removal (default Yes).
      const result = await harness.run('integrate claude', {
        stdinChunks: ['\r', '\r', 'n', '\r'],
      });

      expect(result.exitCode).toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('MCP server (currently installed)  Keep?');
      expect(output).toContain('Proceed with removal?');
      expect(output).toContain('Removing MCP server');
      expect(output).toContain('Removed');

      // MCP server is gone from state; the kept secret scanning hooks remain.
      expect(findClaudeFeature(harness, 'mcp-server')).toBeUndefined();
      expect(findClaudeFeature(harness, 'sonar-secrets-hooks')).toBeDefined();
    },
    { timeout: 30000 },
  );

  it(
    'keeps an installed feature untouched when the user declines removal',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      seedInstalledFeatures();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
      );

      // Project scope, keep the hooks, decline MCP keep ('n') then decline removal ('n').
      const result = await harness.run('integrate claude', {
        stdinChunks: ['\r', '\r', 'n', 'n'],
      });

      expect(result.exitCode).toBe(0);
      // Declining removal leaves the MCP server installed.
      expect(findClaudeFeature(harness, 'mcp-server')).toBeDefined();
    },
    { timeout: 30000 },
  );

  it(
    'uninstalls the sonar-secrets binary when the removed feature was its last referrer',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      seedInstalledFeatures();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
      );

      // Project scope, decline keeping the secrets hooks ('n') then confirm removal
      // (default Yes); keep the MCP server (default Yes). No other feature references
      // sonar-secrets, so the binary is orphaned and uninstalled.
      const result = await harness.run('integrate claude', {
        stdinChunks: ['\r', 'n', '\r', '\r'],
      });

      expect(result.exitCode).toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('secret scanning hooks (currently installed)  Keep?');
      expect(output).toContain('secret scanning hooks will be removed.');

      // The feature is gone and, being the last referrer, so is the binary.
      expect(findClaudeFeature(harness, 'sonar-secrets-hooks')).toBeUndefined();
      const state = harness.stateJsonFile.asJson();
      expect(
        state.dependencies.installed.find((dep: { id: string }) => dep.id === 'sonar-secrets'),
      ).toBeUndefined();
      expect(harness.cliHome.file('bin', buildLocalBinaryName(detectPlatform())).exists()).toBe(
        false,
      );
    },
    { timeout: 30000 },
  );

  it(
    'keeps the sonar-secrets binary when another project still references it',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      seedInstalledFeatures();
      // A second project on this machine also has the secrets hooks installed, so it
      // shares the same sonar-secrets binary.
      harness
        .state()
        .withInstalledIntegrationFeature(
          claudeIntegration,
          'sonar-secrets-hooks',
          'project',
          `${harness.cwd.path}-other-project`,
        );
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
      );

      // Project scope, decline keeping this project's secrets hooks ('n') then confirm
      // removal (default Yes); keep the MCP server (default Yes).
      const result = await harness.run('integrate claude', {
        stdinChunks: ['\r', 'n', '\r', '\r'],
      });

      expect(result.exitCode).toBe(0);

      // This project's feature is removed, but the other project's entry survives, so
      // the binary is neither pruned from state nor deleted from disk.
      const state = harness.stateJsonFile.asJson();
      const claude = state.integrations.installed.find(
        (integration: { integrationId: string }) => integration.integrationId === 'claude-code',
      );
      const remainingSecretsHooks = claude.features.filter(
        (feature: { featureId: string }) => feature.featureId === 'sonar-secrets-hooks',
      );
      expect(remainingSecretsHooks).toHaveLength(1);
      expect(remainingSecretsHooks[0].targetRoot).toBe(`${harness.cwd.path}-other-project`);
      expect(
        state.dependencies.installed.find((dep: { id: string }) => dep.id === 'sonar-secrets'),
      ).toBeDefined();
      expect(harness.cliHome.file('bin', buildLocalBinaryName(detectPlatform())).exists()).toBe(
        true,
      );
    },
    { timeout: 30000 },
  );

  it(
    'keeps installed features without prompting or removing in non-interactive mode',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      seedInstalledFeatures();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive');

      expect(result.exitCode).toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      // Non-interactive runs never offer keep/remove and never uninstall.
      expect(output).not.toContain('Keep?');
      expect(output).not.toContain('will be removed.');
      expect(output).not.toContain('Removing');

      // Both installed features survive untouched.
      expect(findClaudeFeature(harness, 'sonar-secrets-hooks')).toBeDefined();
      expect(findClaudeFeature(harness, 'mcp-server')).toBeDefined();
    },
    { timeout: 30000 },
  );

  it(
    'drops the integration entry from state when its last feature is removed',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      seedInstalledFeatures();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
      );

      // Project scope, then decline + confirm removal for both installed features
      // (secret scanning hooks, then MCP server). No feature remains afterwards.
      const result = await harness.run('integrate claude', {
        stdinChunks: ['\r', 'n', '\r', 'n', '\r'],
      });

      expect(result.exitCode).toBe(0);

      // With no features left, the whole claude-code integration entry is pruned,
      // and the orphaned sonar-secrets binary is uninstalled with it.
      expect(getInstalledIntegration(harness, 'claude-code')).toBeUndefined();
      const state = harness.stateJsonFile.asJson();
      expect(
        state.dependencies.installed.find((dep: { id: string }) => dep.id === 'sonar-secrets'),
      ).toBeUndefined();
      expect(harness.cliHome.file('bin', buildLocalBinaryName(detectPlatform())).exists()).toBe(
        false,
      );
    },
    { timeout: 30000 },
  );
});
