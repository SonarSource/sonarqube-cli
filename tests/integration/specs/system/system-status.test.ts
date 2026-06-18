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

// Integration tests for `sonar system status`

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { version as CLI_VERSION } from '../../../../package.json';
import { SECRETS_SPEC } from '../../../../src/cli/commands/_common/install/secrets';
import {
  formatAntigravityHookCommand,
  hookScriptName,
} from '../../../../src/cli/commands/integrate/antigravity/hooks';
import { IS_WINDOWS, normalizePath, TestHarness } from '../../harness';

function baseState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.0',
    auth: { isAuthenticated: false, connections: [] },
    agents: {
      'claude-code': { configured: false, hooks: { installed: [] }, skills: { installed: [] } },
    },
    config: { cliVersion: CLI_VERSION },
    dependencies: { installed: [] },
    telemetry: { enabled: false, firstUseDate: '', events: [] },
    agentExtensions: [],
    integrations: { installed: [] },
    ...overrides,
  };
}

function makeInstallEntry(
  id: string,
  integrationId: string,
  featureId: string,
  targetRoot: string,
  resources: Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    id,
    integrationId,
    installedByCliVersion: '0.14.0',
    installedAt: new Date().toISOString(),
    updatedByCliVersion: '0.14.0',
    updatedAt: new Date().toISOString(),
    features: [
      {
        featureId,
        scope: 'global',
        targetRoot,
        installedByCliVersion: '0.14.0',
        installedAt: new Date().toISOString(),
        updatedByCliVersion: '0.14.0',
        updatedAt: new Date().toISOString(),
        dependencies: [],
        operations: [],
        resources,
      },
    ],
  };
}

function makeResource(id: string, resourceType: string, path: string): Record<string, unknown> {
  return {
    id,
    resourceType,
    path,
    updatedByCliVersion: '0.14.0',
    updatedAt: new Date().toISOString(),
  };
}

const VALID_MCP_CONFIG = JSON.stringify({
  mcpServers: { sonarqube: { command: 'sonar', args: ['run', 'mcp'] } },
});

const VALID_TOML_MCP_CONFIG = `[mcp_servers.sonarqube]\ncommand = "sonar"\nargs = ["run", "mcp"]\n`;

function codexMcpState(targetRoot: string): Record<string, unknown> {
  return baseState({
    integrations: {
      installed: [makeInstallEntry('test-id', 'codex', 'mcp-server', targetRoot)],
    },
  });
}

function mcpStateWithFeature(targetRoot: string, mcpConfigPath: string): Record<string, unknown> {
  return baseState({
    integrations: {
      installed: [
        makeInstallEntry('test-id', 'claude-code', 'mcp-server', targetRoot, [
          makeResource('claude-mcp-config', 'whole-file', mcpConfigPath),
        ]),
      ],
    },
  });
}

function mcpClaudeIntegrationState(targetRoot: string): Record<string, unknown> {
  return baseState({
    integrations: {
      installed: [makeInstallEntry('test-id', 'claude-code', 'mcp-server', targetRoot)],
    },
  });
}

function legacyAgentState(): Record<string, unknown> {
  return baseState({
    agents: {
      'claude-code': { configured: true, hooks: { installed: [] }, skills: { installed: [] } },
    },
  });
}

function antigravityStatusState(
  targetRoot: string,
  scope: 'project' | 'global' = 'project',
): Record<string, unknown> {
  const featureTemplate = {
    scope,
    targetRoot,
    installedByCliVersion: '0.14.0',
    installedAt: new Date().toISOString(),
    updatedByCliVersion: '0.14.0',
    updatedAt: new Date().toISOString(),
    dependencies: [],
    operations: [],
    resources: [],
  };

  return baseState({
    integrations: {
      installed: [
        {
          id: 'antigravity-test',
          integrationId: 'antigravity',
          installedByCliVersion: '0.14.0',
          installedAt: new Date().toISOString(),
          updatedByCliVersion: '0.14.0',
          updatedAt: new Date().toISOString(),
          features: [
            { ...featureTemplate, featureId: 'sonar-secrets-hooks' },
            { ...featureTemplate, featureId: 'mcp-server' },
          ],
        },
      ],
    },
  });
}

describe('system status', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.newFakeUpdateScriptServer(CLI_VERSION);
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits 0 and shows CLI version',
    async () => {
      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`v${CLI_VERSION}`);
    },
    { timeout: 15000 },
  );

  it(
    'shows not authenticated when no connection exists',
    async () => {
      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Not Set');
    },
    { timeout: 15000 },
  );

  it(
    'shows authenticated with server URL for SQS connection',
    async () => {
      const server = await harness.newFakeServer().start();
      harness.state().withAuth(server.baseUrl(), 'my-token');

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('AUTHENTICATION');
      expect(result.stdout).toContain(server.baseUrl());
      expect(result.stdout).toContain('Token:   Active');
    },
    { timeout: 15000 },
  );

  it(
    'shows authenticated with server URL and org for SQC connection',
    async () => {
      // Use server.baseUrl() so checkTokenStatus hits the fake server, not real sonarcloud.io
      const server = await harness.newFakeServer().withAuthToken('my-token').start();
      harness.state().withAuth(server.baseUrl(), 'my-token', 'my-org');

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('AUTHENTICATION');
      expect(result.stdout).toContain(server.baseUrl());
      expect(result.stdout).toContain('my-org');
      expect(result.stdout).toContain('Token:   Active');
    },
    { timeout: 15000 },
  );

  it(
    'shows invalid token in text and JSON output and recommends reauthentication',
    async () => {
      // withAuthToken('valid-token') but auth uses 'bad-token' → validate returns false
      const server = await harness.newFakeServer().withAuthToken('valid-token').start();
      harness.state().withAuth(server.baseUrl(), 'bad-token');

      const textResult = await harness.run('system status');
      expect(textResult.exitCode).toBe(0);
      expect(textResult.stdout).toContain('Token:   Invalid');
      expect(textResult.stderr).toContain('Issues found');
      expect(textResult.stdout).toContain('RECOMMENDATIONS');
      expect(textResult.stdout).toContain('reauthenticate');

      const jsonResult = await harness.run('system status --json');
      expect(jsonResult.exitCode).toBe(0);
      const json = JSON.parse(jsonResult.stdout) as { auth: { token: string } };
      expect(json.auth.token).toBe('invalid');
    },
    { timeout: 15000 },
  );

  it(
    'shows set_unverified token in text and JSON output when server is unreachable',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('my-token').start();
      const serverUrl = server.baseUrl();
      await server.stop();
      harness.state().withAuth(serverUrl, 'my-token');

      const textResult = await harness.run('system status');
      expect(textResult.exitCode).toBe(0);
      expect(textResult.stdout).toContain('Token:   Set, Unverified');

      const jsonResult = await harness.run('system status --json');
      expect(jsonResult.exitCode).toBe(0);
      const json = JSON.parse(jsonResult.stdout) as { auth: { token: string } };
      expect(json.auth.token).toBe('set_unverified');
    },
    { timeout: 15000 },
  );

  it(
    'shows installed binary when sonar-secrets is present',
    async () => {
      harness.state().withSecretsBinaryInstalled();

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Secrets Detection');
      expect(result.stdout).toContain('BINARIES');
    },
    { timeout: 15000 },
  );

  it(
    'outputs valid JSON with --json flag when not authenticated',
    async () => {
      const result = await harness.run('system status --json');

      expect(result.exitCode).toBe(0);

      const json = JSON.parse(result.stdout) as {
        version: string;
        auth: { status: string };
        binaries: unknown[];
        integrations: unknown[];
      };
      expect(json.version).toBe(CLI_VERSION);
      expect(json.auth.status).toBe('unauthenticated');
      expect(json.binaries).toEqual([]);
      expect(json.integrations).toEqual([]);
    },
    { timeout: 15000 },
  );

  it(
    'outputs valid JSON with server, org and token status when authenticated',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('my-token').start();
      harness.state().withAuth(server.baseUrl(), 'my-token', 'my-org');

      const result = await harness.run('system status --json');

      expect(result.exitCode).toBe(0);

      const json = JSON.parse(result.stdout) as {
        version: string;
        auth: { status: string; server: string; org: string; token: string };
        binaries: unknown[];
        integrations: unknown[];
      };
      expect(json.auth.status).toBe('authenticated');
      expect(json.auth.server).toBe(server.baseUrl());
      expect(json.auth.org).toBe('my-org');
      expect(json.auth.token).toBe('active');
    },
    { timeout: 15000 },
  );

  it(
    'shows legacy claude-code agent as Claude Code in text and JSON output',
    async () => {
      harness.state().withRawState(JSON.stringify(legacyAgentState()));

      const textResult = await harness.run('system status');
      expect(textResult.exitCode).toBe(0);
      expect(textResult.stdout).toContain('Claude Code');
      expect(textResult.stdout).toContain('INTEGRATIONS');

      const jsonResult = await harness.run('system status --json');
      expect(jsonResult.exitCode).toBe(0);
      const json = JSON.parse(jsonResult.stdout) as {
        integrations: Array<{ id: string; name: string; path?: string }>;
      };
      expect(json.integrations.length).toBe(1);
      expect(json.integrations[0].path).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it(
    'outputs binary info in JSON when sonar-secrets is installed',
    async () => {
      harness.state().withSecretsBinaryInstalled();

      const result = await harness.run('system status --json');

      expect(result.exitCode).toBe(0);

      const json = JSON.parse(result.stdout) as {
        binaries: Array<{ name: string; version: string; path: string; updateAvailable: boolean }>;
      };
      expect(json.binaries.length).toBe(1);
      expect(json.binaries[0].name).toBe('Secrets Detection');
      expect(json.binaries[0].version).toBeTruthy();
      expect(json.binaries[0].path).toBeTruthy();
      expect(json.binaries[0].path).toContain('~');
    },
    { timeout: 15000 },
  );

  it(
    'shows binary update available when installed version differs from bundled',
    async () => {
      harness.state().withRawState(
        JSON.stringify({
          version: '1.0',
          auth: { isAuthenticated: false, connections: [] },
          agents: {
            'claude-code': {
              configured: false,
              hooks: { installed: [] },
              skills: { installed: [] },
            },
          },
          config: { cliVersion: CLI_VERSION },
          tools: {
            installed: [
              {
                name: SECRETS_SPEC.name,
                version: '1.0.0',
                path: '/fake/path/sonar-secrets',
                installedAt: new Date().toISOString(),
                installedByCliVersion: '0.14.0',
              },
            ],
          },
          dependencies: { installed: [] },
          telemetry: { enabled: false, firstUseDate: '', events: [] },
          agentExtensions: [],
          integrations: { installed: [] },
        }),
      );

      const result = await harness.run('system status --json');

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout) as {
        binaries: Array<{ name: string; updateAvailable: boolean }>;
      };
      expect(json.binaries[0].updateAvailable).toBe(true);
    },
    { timeout: 15000 },
  );

  it(
    'shows MCP configured when valid claude.json exists',
    async () => {
      harness.userHome.writeFile('.claude.json', VALID_MCP_CONFIG);
      harness
        .state()
        .withRawState(JSON.stringify(mcpClaudeIntegrationState(harness.userHome.path)));

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('CONFIGURED');
    },
    { timeout: 15000 },
  );

  it(
    'shows INVALID CONFIG status and recommends re-integration when claude.json has malformed sonarqube entry',
    async () => {
      harness.userHome.writeFile(
        '.claude.json',
        JSON.stringify({ mcpServers: { sonarqube: 'not-an-object' } }),
      );
      harness
        .state()
        .withRawState(JSON.stringify(mcpClaudeIntegrationState(harness.userHome.path)));

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('CONFIGURED / INVALID CONFIG');
      expect(result.stdout).toContain('RECOMMENDATIONS');
      expect(result.stdout).toContain('sonar integrate claude');
    },
    { timeout: 15000 },
  );

  it(
    'shows recommendations when not authenticated',
    async () => {
      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('RECOMMENDATIONS');
      expect(result.stdout).toContain('sonar auth login');
    },
    { timeout: 15000 },
  );

  it(
    'includes recommendations in --json output',
    async () => {
      const result = await harness.run('system status --json');

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout) as { recommendations: string[] };
      expect(json.recommendations.length).toBeGreaterThan(0);
      expect(json.recommendations[0]).toContain('sonar auth login');
    },
    { timeout: 15000 },
  );

  it(
    'shows healthy system check when authenticated and no issues',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('my-token').start();
      harness.state().withAuth(server.baseUrl(), 'my-token');

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Token:   Active');
      expect(result.stderr).not.toContain('Issues found');
    },
    { timeout: 15000 },
  );

  it(
    'shows declarative integration with path from installed resources',
    async () => {
      harness.state().withRawState(
        JSON.stringify(
          baseState({
            integrations: {
              installed: [
                makeInstallEntry('test-id', 'codex', 'sonar-secrets-hooks', harness.userHome.path, [
                  makeResource(
                    'codex-hooks-secrets-hook',
                    'json-patch',
                    join(harness.userHome.path, '.codex', 'hooks.json'),
                  ),
                ]),
              ],
            },
          }),
        ),
      );

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Codex: CONFIGURED');
      expect(normalizePath(result.stdout)).toContain('.codex/hooks.json');
    },
    { timeout: 15000 },
  );

  it.skipIf(IS_WINDOWS)(
    'shows MCP not running when docker available but container absent',
    async () => {
      const mcpConfigPath = join(harness.userHome.path, '.claude.json');
      harness.state().withDockerMock(false);
      harness
        .state()
        .withRawState(JSON.stringify(mcpStateWithFeature(harness.userHome.path, mcpConfigPath)));
      harness.userHome.writeFile('.claude.json', VALID_MCP_CONFIG);

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('CONFIGURED');
    },
    { timeout: 15000 },
  );

  it.skipIf(IS_WINDOWS)(
    'shows MCP configured status without checking docker',
    async () => {
      const mcpConfigPath = join(harness.userHome.path, '.claude.json');
      harness
        .state()
        .withRawState(JSON.stringify(mcpStateWithFeature(harness.userHome.path, mcpConfigPath)));
      harness.userHome.writeFile('.claude.json', VALID_MCP_CONFIG);

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('CONFIGURED');
    },
    { timeout: 15000 },
  );

  it(
    'shows CLI update recommendation when newer version is available',
    async () => {
      const newerVersion = '99.0.0';
      const sqServer = await harness.newFakeServer().withAuthToken('my-token').start();
      harness.newFakeUpdateScriptServer(newerVersion);
      harness.state().withAuth(sqServer.baseUrl(), 'my-token', 'my-org');

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('RECOMMENDATIONS');
      expect(result.stdout).toContain('sonar self-update');
      expect(result.stdout).toContain(newerVersion);
    },
    { timeout: 15000 },
  );

  it(
    'shows MCP invalid config when claude.json sonarqube entry has wrong command type',
    async () => {
      harness.userHome.writeFile(
        '.claude.json',
        JSON.stringify({ mcpServers: { sonarqube: { command: 123, args: [] } } }),
      );
      harness
        .state()
        .withRawState(JSON.stringify(mcpClaudeIntegrationState(harness.userHome.path)));

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('CONFIGURED / INVALID CONFIG');
    },
    { timeout: 15000 },
  );

  it(
    'shows MCP invalid config when claude.json is not valid JSON',
    async () => {
      harness.userHome.writeFile('.claude.json', '{not: valid json!!!');
      harness
        .state()
        .withRawState(JSON.stringify(mcpClaudeIntegrationState(harness.userHome.path)));

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('CONFIGURED / INVALID CONFIG');
    },
    { timeout: 15000 },
  );

  it(
    'shows MCP not configured when feature is registered but config file is absent',
    async () => {
      const missingPath = join(harness.userHome.path, '.claude.json');
      harness
        .state()
        .withRawState(JSON.stringify(mcpStateWithFeature(harness.userHome.path, missingPath)));
      // intentionally do NOT write the config file

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('NOT CONFIGURED');
    },
    { timeout: 15000 },
  );

  it(
    'shows MCP configured when valid Codex TOML config exists',
    async () => {
      harness.userHome.writeFile(join('.codex', 'config.toml'), VALID_TOML_MCP_CONFIG);
      harness.state().withRawState(JSON.stringify(codexMcpState(harness.userHome.path)));

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('CONFIGURED');
    },
    { timeout: 15000 },
  );

  it(
    'shows MCP not configured when Codex TOML exists but has no sonarqube entry',
    async () => {
      harness.userHome.writeFile(join('.codex', 'config.toml'), '[other_section]\nkey = "value"\n');
      harness.state().withRawState(JSON.stringify(codexMcpState(harness.userHome.path)));

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('NOT CONFIGURED');
    },
    { timeout: 15000 },
  );

  it(
    'shows MCP invalid config when Codex TOML has malformed sonarqube entry',
    async () => {
      harness.userHome.writeFile(
        join('.codex', 'config.toml'),
        '[mcp_servers]\nsonarqube = "not-a-table"\n',
      );
      harness.state().withRawState(JSON.stringify(codexMcpState(harness.userHome.path)));

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('CONFIGURED / INVALID CONFIG');
    },
    { timeout: 15000 },
  );

  it(
    'shows MCP invalid config when Codex TOML is not valid TOML',
    async () => {
      harness.userHome.writeFile(join('.codex', 'config.toml'), '{not: valid toml!!!');
      harness.state().withRawState(JSON.stringify(codexMcpState(harness.userHome.path)));

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('CONFIGURED / INVALID CONFIG');
    },
    { timeout: 15000 },
  );

  it(
    'shows claude-code integration path from agentExtensions hook entry',
    async () => {
      harness.state().withRawState(
        JSON.stringify({
          version: '1.0',
          auth: { isAuthenticated: false, connections: [] },
          agents: {
            'claude-code': {
              configured: true,
              hooks: { installed: [] },
              skills: { installed: [] },
            },
          },
          config: { cliVersion: CLI_VERSION },
          dependencies: { installed: [] },
          telemetry: { enabled: false, firstUseDate: '', events: [] },
          agentExtensions: [
            {
              id: 'ext-1',
              agentId: 'claude-code',
              kind: 'hook',
              name: 'sonar-secrets',
              hookType: 'PreToolUse',
              projectRoot: harness.userHome.path,
              global: true,
              updatedByCliVersion: '0.14.0',
              updatedAt: new Date().toISOString(),
            },
          ],
          integrations: { installed: [] },
        }),
      );

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(normalizePath(result.stdout)).toContain('.claude/settings.json');
    },
    { timeout: 15000 },
  );

  it(
    'reports update check as unavailable when update server is unreachable',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('my-token').start();
      harness.state().withAuth(server.baseUrl(), 'my-token');

      // Override the update script URL to an unreachable port so checkForUpdate throws
      // and the .catch(() => null) path is exercised
      const result = await harness.run('system status', {
        extraEnv: { SONARQUBE_CLI_UPDATE_SCRIPT_BASE_URL: 'http://127.0.0.1:1' },
      });

      expect(result.exitCode).toBe(0);
      // No update recommendation when the update check fails
      expect(result.stdout).not.toContain('sonar self-update');
    },
    { timeout: 15000 },
  );

  it(
    'shows all dependency binaries when multiple entries exist in dependencies.installed',
    async () => {
      harness.state().withRawState(
        JSON.stringify(
          baseState({
            dependencies: {
              installed: [
                {
                  id: 'sonar-context-augmentation',
                  dependencyType: 'binary',
                  version: '0.12.0.1451',
                  path: '/fake/bin/sonar-context-augmentation',
                  updatedByCliVersion: '0.14.0',
                  updatedAt: new Date().toISOString(),
                },
                {
                  id: 'sca-scanner-cli',
                  dependencyType: 'binary',
                  version: '2025.6.0.14965',
                  path: '/fake/bin/sca-scanner-cli',
                  updatedByCliVersion: '0.14.0',
                  updatedAt: new Date().toISOString(),
                },
              ],
            },
          }),
        ),
      );

      const result = await harness.run('system status --json');

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout) as { binaries: Array<{ name: string }> };
      const names = json.binaries.map((b) => b.name);
      expect(names).toContain('Sonar Context Augmentation');
      expect(names).toContain('Dependency Risks Scanner');
    },
    { timeout: 15000 },
  );

  it(
    'shows one entry per agent when multiple different integrations are installed',
    async () => {
      harness.state().withRawState(
        JSON.stringify(
          baseState({
            integrations: {
              installed: [
                makeInstallEntry(
                  'id-1',
                  'claude-code',
                  'sonar-secrets-hooks',
                  harness.userHome.path,
                  [
                    makeResource(
                      'r1',
                      'json-patch',
                      join(harness.userHome.path, '.claude', 'settings.json'),
                    ),
                  ],
                ),
                makeInstallEntry('id-2', 'codex', 'sonar-secrets-hooks', harness.userHome.path, [
                  makeResource(
                    'r2',
                    'json-patch',
                    join(harness.userHome.path, '.codex', 'hooks.json'),
                  ),
                ]),
              ],
            },
          }),
        ),
      );

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Claude Code');
      expect(result.stdout).toContain('Codex');
    },
    { timeout: 15000 },
  );

  it(
    'shows one entry per project when the same agent is installed in multiple projects',
    async () => {
      // The framework stores one InstalledIntegration per integrationId; each
      // project install adds a feature with its own targetRoot (scope: local).
      const rootA = join(harness.userHome.path, 'proj-a');
      const rootB = join(harness.userHome.path, 'proj-b');
      harness.state().withRawState(
        JSON.stringify(
          baseState({
            integrations: {
              installed: [
                {
                  id: 'test-id',
                  integrationId: 'claude-code',
                  installedByCliVersion: '0.14.0',
                  installedAt: new Date().toISOString(),
                  updatedByCliVersion: '0.14.0',
                  updatedAt: new Date().toISOString(),
                  features: [
                    {
                      featureId: 'sonar-secrets-hooks',
                      scope: 'local',
                      targetRoot: rootA,
                      installedByCliVersion: '0.14.0',
                      installedAt: new Date().toISOString(),
                      updatedByCliVersion: '0.14.0',
                      updatedAt: new Date().toISOString(),
                      dependencies: [],
                      operations: [],
                      resources: [
                        makeResource('r1', 'json-patch', join(rootA, '.claude', 'settings.json')),
                      ],
                    },
                    {
                      featureId: 'sonar-secrets-hooks',
                      scope: 'local',
                      targetRoot: rootB,
                      installedByCliVersion: '0.14.0',
                      installedAt: new Date().toISOString(),
                      updatedByCliVersion: '0.14.0',
                      updatedAt: new Date().toISOString(),
                      dependencies: [],
                      operations: [],
                      resources: [
                        makeResource('r2', 'json-patch', join(rootB, '.claude', 'settings.json')),
                      ],
                    },
                  ],
                },
              ],
            },
          }),
        ),
      );

      const result = await harness.run('system status --json');

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout) as { integrations: Array<{ id: string }> };
      expect(json.integrations.filter((i) => i.id === 'claude-code')).toHaveLength(2);
    },
    { timeout: 15000 },
  );

  it(
    'shows one entry per project when sonar integrate claude is run in two different directories',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      await harness.newFakeBinariesServer().start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const sonarProps = [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join(
        '\n',
      );

      // Project A — default cwd
      harness.cwd.writeFile('sonar-project.properties', sonarProps);
      const resultA = await harness.run('integrate claude --non-interactive');
      expect(resultA.exitCode).toBe(0);

      // Preserve state written by project A so the next harness.run() doesn't overwrite it
      harness.state().withRawState(harness.stateJsonFile.asText());

      // Project B — sibling directory
      const projectBPath = join(harness.cwd.path, '..', 'project-b');
      mkdirSync(projectBPath, { recursive: true });
      writeFileSync(join(projectBPath, 'sonar-project.properties'), sonarProps);
      const resultB = await harness.run('integrate claude --non-interactive', {
        cwd: projectBPath,
      });
      expect(resultB.exitCode).toBe(0);

      // Preserve state with both integrations before running system status
      harness.state().withRawState(harness.stateJsonFile.asText());

      // Both installations must appear in system status
      const result = await harness.run('system status --json');
      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout) as { integrations: Array<{ id: string }> };
      expect(json.integrations.filter((i) => i.id === 'claude-code')).toHaveLength(2);
    },
    { timeout: 60000 },
  );

  it(
    'shows MCP status nested under Claude integration in text output',
    async () => {
      harness.userHome.writeFile('.claude.json', VALID_MCP_CONFIG);
      harness
        .state()
        .withRawState(JSON.stringify(mcpClaudeIntegrationState(harness.userHome.path)));

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.split('\n');
      // Find "Claude Code" line
      const claudeLineIdx = lines.findIndex((l) => l.includes('Claude Code'));
      expect(claudeLineIdx).toBeGreaterThanOrEqual(0);
      // MCP Server should appear indented after Claude Code, not as a separate top-level entry
      const nextLine = lines[claudeLineIdx + 1];
      expect(nextLine).toContain('MCP Server');
      expect(nextLine).toMatch(/^\s{4}•/); // indented with 4 spaces + bullet
    },
    { timeout: 15000 },
  );

  it(
    'includes MCP status per integration in JSON output',
    async () => {
      harness.userHome.writeFile('.claude.json', VALID_MCP_CONFIG);
      harness
        .state()
        .withRawState(JSON.stringify(mcpClaudeIntegrationState(harness.userHome.path)));

      const result = await harness.run('system status --json');

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout) as {
        integrations: Array<{ id: string; mcp?: { configured: boolean } }>;
      };
      const claudeIntegration = json.integrations.find((i) => i.id === 'claude-code');
      expect(claudeIntegration).toBeDefined();
      expect(claudeIntegration?.mcp).toBeDefined();
      expect(claudeIntegration?.mcp?.configured).toBe(true);
    },
    { timeout: 15000 },
  );

  it(
    'shows invalid MCP config under specific agent, not globally',
    async () => {
      const invalidConfig = JSON.stringify({ mcpServers: { sonarqube: null } });
      harness.userHome.writeFile('.claude.json', invalidConfig);
      harness
        .state()
        .withRawState(JSON.stringify(mcpClaudeIntegrationState(harness.userHome.path)));

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Claude Code');
      expect(result.stdout).toContain('INVALID CONFIG');
      expect(result.stdout).toContain('RECOMMENDATIONS');
      expect(result.stdout).toContain('sonar integrate claude');
    },
    { timeout: 15000 },
  );

  it(
    'does not show MCP status when no agents have MCP configured',
    async () => {
      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      // Should not contain any "MCP Server" line when no MCP is configured
      const lines = result.stdout.split('\n');
      const mcpLines = lines.filter((l) => l.includes('MCP Server'));
      expect(mcpLines).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'shows separate MCP status for each integration when multiple have MCP configured',
    async () => {
      // Create state with multiple integrations, each with MCP
      const claudeGlobalRoot = harness.userHome.path;
      const copilotGlobalRoot = join(harness.userHome.path, '.copilot');
      mkdirSync(copilotGlobalRoot, { recursive: true });

      harness.userHome.writeFile('.claude.json', VALID_MCP_CONFIG);
      harness.userHome.writeFile('.copilot/mcp-config.json', VALID_MCP_CONFIG);

      const multiMcpState = baseState({
        integrations: {
          installed: [
            makeInstallEntry('claude-id', 'claude-code', 'mcp-server', claudeGlobalRoot),
            makeInstallEntry('copilot-id', 'copilot-cli', 'mcp-server', copilotGlobalRoot),
          ],
        },
      });

      harness.state().withRawState(JSON.stringify(multiMcpState));

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      const stdout = result.stdout;

      // Both Claude Code and Copilot should appear
      expect(stdout).toContain('Claude Code');
      expect(stdout).toContain('Copilot');

      // Count MCP Server lines — should be 2 (one for each integration)
      const lines = stdout.split('\n');
      const mcpLines = lines.filter((l) => l.includes('MCP Server'));
      expect(mcpLines).toHaveLength(2);

      // Both should show CONFIGURED status
      mcpLines.forEach((line) => {
        expect(line).toContain('CONFIGURED');
      });
    },
    { timeout: 15000 },
  );

  it(
    'shows correct MCP status per integration in JSON when multiple agents have MCP',
    async () => {
      const claudeGlobalRoot = harness.userHome.path;
      const copilotGlobalRoot = join(harness.userHome.path, '.copilot');
      mkdirSync(copilotGlobalRoot, { recursive: true });

      harness.userHome.writeFile('.claude.json', VALID_MCP_CONFIG);
      harness.userHome.writeFile('.copilot/mcp-config.json', VALID_MCP_CONFIG);

      const multiMcpState = baseState({
        integrations: {
          installed: [
            makeInstallEntry('claude-id', 'claude-code', 'mcp-server', claudeGlobalRoot),
            makeInstallEntry('copilot-id', 'copilot-cli', 'mcp-server', copilotGlobalRoot),
          ],
        },
      });

      harness.state().withRawState(JSON.stringify(multiMcpState));

      const result = await harness.run('system status --json');

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout) as {
        integrations: Array<{ id: string; mcp?: { configured: boolean } }>;
      };

      // Find both integrations
      const claude = json.integrations.find((i) => i.id === 'claude-code');
      const copilot = json.integrations.find((i) => i.id === 'copilot-cli');

      expect(claude).toBeDefined();
      expect(copilot).toBeDefined();

      // Both should have MCP configured
      expect(claude?.mcp?.configured).toBe(true);
      expect(copilot?.mcp?.configured).toBe(true);
    },
    { timeout: 15000 },
  );

  it(
    'shows Antigravity secrets hook and MCP status when both are configured',
    async () => {
      const scriptPath = join(harness.cwd.path, '.agents', 'sonar', 'hooks', hookScriptName());
      mkdirSync(join(harness.cwd.path, '.agents', 'sonar', 'hooks'), { recursive: true });
      writeFileSync(scriptPath, '#!/bin/bash\n');
      writeFileSync(
        join(harness.cwd.path, '.agents', 'hooks.json'),
        JSON.stringify({
          'sonar-secrets': {
            enabled: true,
            PreToolUse: [
              {
                matcher: 'view_file',
                hooks: [{ command: formatAntigravityHookCommand(scriptPath) }],
              },
            ],
          },
        }),
      );
      harness.userHome.writeFile(join('.gemini', 'config', 'mcp_config.json'), VALID_MCP_CONFIG);
      harness.state().withRawState(JSON.stringify(antigravityStatusState(harness.cwd.path)));

      const result = await harness.run('system status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Antigravity');
      expect(result.stdout).toContain('Secrets Hook');
      expect(result.stdout).toContain('MCP Server');

      const jsonResult = await harness.run('system status --json');
      expect(jsonResult.exitCode).toBe(0);
      const json = JSON.parse(jsonResult.stdout) as {
        integrations: Array<{
          id: string;
          hooks?: { valid: boolean };
          mcp?: { valid: boolean };
        }>;
      };
      const antigravity = json.integrations.find((entry) => entry.id === 'antigravity');
      expect(antigravity?.hooks?.valid).toBe(true);
      expect(antigravity?.mcp?.valid).toBe(true);
    },
    { timeout: 15000 },
  );
});
