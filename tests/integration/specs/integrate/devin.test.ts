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

// Integration tests for `sonar integrate devin`.

import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { resolveDevinConfigDir } from '@/core/host/environment/devin-config-dir.ts';

import { TestHarness } from '../../harness';
import { buildHomeEnv } from '../../harness/platform';
import { findInstalledFeature } from './state-helpers';

// Devin's config dir is per-OS (~/.config/devin, %APPDATA%\devin on Windows); resolve it with the
// same env the harness gives the CLI so the test sets up what the detector will look for.
function writeDevinConfig(harness: TestHarness): void {
  const home = harness.userHome.path;
  const configDir = resolveDevinConfigDir(home, buildHomeEnv(home));
  harness.userHome.writeFile(join(relative(home, configDir), 'config.json'), '{}');
}

function devinConfigRelPath(harness: TestHarness, fileName: string): string {
  const home = harness.userHome.path;
  return join(relative(home, resolveDevinConfigDir(home, buildHomeEnv(home))), fileName);
}

describe('integrate devin', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
    await harness.newFakeBinariesServer().start();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'is hidden from help output but still runs when typed explicitly',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');

      const rootHelp = await harness.run('');
      const integrateHelp = await harness.run('integrate --help');
      expect(rootHelp.stdout).not.toMatch(/devin/i);
      expect(integrateHelp.stdout + integrateHelp.stderr).not.toMatch(/devin/i);

      const result = await harness.run('integrate devin --non-interactive');
      expect(result.exitCode).toBe(0);
    },
    { timeout: 30000 },
  );

  it(
    'writes the sonarqube MCP server without a project key and keeps the user entries',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
      );
      const mcpConfigPath = devinConfigRelPath(harness, 'mcp_config.json');
      harness.userHome.writeFile(
        mcpConfigPath,
        JSON.stringify({
          theme: 'dark',
          mcpServers: { other: { command: 'other-mcp', args: ['--flag'] } },
        }),
      );

      const result = await harness.run('integrate devin --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(harness.userHome.file(mcpConfigPath).asJson()).toEqual({
        theme: 'dark',
        mcpServers: {
          other: { command: 'other-mcp', args: ['--flag'] },
          sonarqube: { command: 'sonar', args: ['run', 'mcp'] },
        },
      });
      expect(findInstalledFeature(harness, 'devin', 'mcp-server', 'global')).toBeDefined();
    },
    { timeout: 30000 },
  );

  it(
    'creates mcp_config.json when the Devin config directory has none',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');

      const result = await harness.run('integrate devin --non-interactive');

      expect(result.exitCode).toBe(0);
      const mcpConfigPath = devinConfigRelPath(harness, 'mcp_config.json');
      expect(harness.userHome.file(mcpConfigPath).asJson()).toEqual({
        mcpServers: { sonarqube: { command: 'sonar', args: ['run', 'mcp'] } },
      });
    },
    { timeout: 30000 },
  );

  describe('-g/--global (deprecated no-op)', () => {
    it(
      'documents --global as deprecated in --help',
      async () => {
        const result = await harness.run('integrate devin --help');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('--non-interactive');
        expect(result.stdout).toContain('--global');
        expect(result.stdout).toContain('[DEPRECATED]');
      },
      { timeout: 15000 },
    );

    it(
      'warns that --global is deprecated but still completes the (already global) install',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        const result = await harness.run('integrate devin --non-interactive --global');

        expect(result.stderr).toContain(
          "'--global' is deprecated since 1.9.0 and will be removed in a future version. Use 'sonar integrate devin' instead.",
        );
        expect(result.exitCode).toBe(0);
      },
      { timeout: 30000 },
    );
  });


  it(
    'is not offered in the bare integrate agent picker',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');

      const session = harness.runInteractive('integrate');
      await session.waitText('Select the tool you want to integrate with');
      session.keyCtrlC();
      const result = await session.waitFinish();

      expect(result.stdout + result.stderr).not.toContain('Devin');
    },
    { timeout: 15000 },
  );

  it(
    'does not list Devin as detected while its integration is unreleased',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');
      harness.userHome.writeFile('.codex/config.toml', '');
      writeDevinConfig(harness);

      const session = harness.runInteractive('integrate');
      await session.waitText('Detected agents on your machine: Codex');
      session.keyCtrlC();
      const result = await session.waitFinish();

      expect(result.stdout + result.stderr).not.toContain('Devin');
    },
    { timeout: 15000 },
  );

  it(
    'does not warn about a Claude and Devin conflict while Devin is unreleased',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');
      harness.userHome.writeFile('.claude.json', '{}');
      writeDevinConfig(harness);

      const session = harness.runInteractive('integrate');
      await session.waitText('Select the tool you want to integrate with');
      session.keyCtrlC();
      const result = await session.waitFinish();

      expect(result.stdout + result.stderr).not.toContain('Devin');
    },
    { timeout: 15000 },
  );

  it(
    'is idempotent: re-running leaves a single identical sonarqube entry',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');
      const mcpConfigPath = devinConfigRelPath(harness, 'mcp_config.json');

      await harness.run('integrate devin --non-interactive');
      const first = harness.userHome.file(mcpConfigPath).asJson();
      const result = await harness.run('integrate devin --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(harness.userHome.file(mcpConfigPath).asJson()).toEqual(first);
    },
    { timeout: 30000 },
  );

  it(
    'fails and leaves the file untouched when mcp_config.json holds invalid JSON',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');
      const mcpConfigPath = devinConfigRelPath(harness, 'mcp_config.json');
      harness.userHome.writeFile(mcpConfigPath, '{ invalid json');

      const result = await harness.run('integrate devin --non-interactive');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('mcp_config.json contains invalid JSON');
      expect(harness.userHome.file(mcpConfigPath).asText()).toBe('{ invalid json');
    },
    { timeout: 30000 },
  );
});
