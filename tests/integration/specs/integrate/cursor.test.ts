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

// Integration tests for `sonar integrate cursor`.
// PR 1 (CLI-619): covers MCP server setup, scope semantics, idempotency, and
// state recording. Hook and CAG tests are added in subsequent PRs.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';
import { findInstalledFeature, getInstalledIntegration } from './state-helpers';

const MCP_JSON_DIRS = ['.cursor', 'mcp.json'];

interface CursorMcpFile {
  mcpServers?: Record<string, { command?: string; args?: string[] }>;
}

describe('integrate cursor', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    const server = await harness.newFakeServer().withAuthToken('tok').start();
    harness.withAuth(server.baseUrl(), 'tok');
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('is not listed in sonar integrate --help (hidden until GA)', async () => {
    const result = await harness.run('integrate --help');
    expect(result.stdout).not.toContain('cursor');
  });

  describe('project-level install (default)', () => {
    it(
      'writes .cursor/mcp.json with a sonarqube MCP server entry',
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

        const result = await harness.run('integrate cursor --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(...MCP_JSON_DIRS)).toBe(true);

        const mcp: CursorMcpFile = harness.cwd.file(...MCP_JSON_DIRS).asJson();
        expect(mcp.mcpServers?.sonarqube).toBeDefined();
        expect(mcp.mcpServers?.sonarqube?.command).toBeDefined();
        expect(mcp.mcpServers?.sonarqube?.args).toContain('mcp');
      },
      { timeout: 30000 },
    );

    it(
      'records mcp-server feature in state with project scope',
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

        const result = await harness.run('integrate cursor --non-interactive');

        expect(result.exitCode).toBe(0);

        const integration = getInstalledIntegration(harness, 'cursor');
        expect(integration).toBeDefined();
        expect(integration!.features.map((f) => f.featureId).sort()).toEqual(['mcp-server']);

        const mcpFeature = findInstalledFeature(harness, 'cursor', 'mcp-server');
        expect(mcpFeature).toMatchObject({
          scope: 'project',
          resources: [
            {
              id: 'cursor-mcp-config',
              resourceType: 'json-patch',
              path: harness.cwd.file(...MCP_JSON_DIRS).path,
            },
          ],
        });
      },
      { timeout: 30000 },
    );

    it(
      'uses a project-relative command path so the config is portable',
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

        await harness.run('integrate cursor --non-interactive');

        const mcp: CursorMcpFile = harness.cwd.file(...MCP_JSON_DIRS).asJson();
        expect(mcp.mcpServers?.sonarqube?.args).toContain('my-project');
      },
      { timeout: 30000 },
    );

    it(
      're-running is idempotent — does not duplicate mcpServers entries',
      async () => {
        await harness.run('integrate cursor --non-interactive');
        const firstBody = harness.cwd.file(...MCP_JSON_DIRS).asText();

        const result = await harness.run('integrate cursor --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.file(...MCP_JSON_DIRS).asText()).toBe(firstBody);

        const mcp: CursorMcpFile = harness.cwd.file(...MCP_JSON_DIRS).asJson();
        expect(Object.keys(mcp.mcpServers ?? {})).toHaveLength(1);
      },
      { timeout: 30000 },
    );

    it(
      'fails when the existing .cursor/mcp.json contains invalid JSON',
      async () => {
        harness.cwd.writeFile('.cursor/mcp.json', '{ invalid json');

        const result = await harness.run('integrate cursor --non-interactive');

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('invalid JSON');
      },
      { timeout: 30000 },
    );
  });

  describe('global install (-g)', () => {
    it(
      'writes to ~/.cursor/mcp.json and not to the project directory',
      async () => {
        const result = await harness.run('integrate cursor -g --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(...MCP_JSON_DIRS)).toBe(false);
        expect(harness.userHome.exists(...MCP_JSON_DIRS)).toBe(true);

        const mcp: CursorMcpFile = harness.userHome.file(...MCP_JSON_DIRS).asJson();
        expect(mcp.mcpServers?.sonarqube).toBeDefined();
        expect(mcp.mcpServers?.sonarqube?.args).toContain('mcp');
      },
      { timeout: 30000 },
    );

    it(
      'records mcp-server feature with global scope in state',
      async () => {
        const result = await harness.run('integrate cursor -g --non-interactive');

        expect(result.exitCode).toBe(0);

        const mcpFeature = findInstalledFeature(harness, 'cursor', 'mcp-server', 'global');
        expect(mcpFeature).toBeDefined();
        expect(mcpFeature).toMatchObject({
          scope: 'global',
          resources: [
            {
              id: 'cursor-mcp-config',
              resourceType: 'json-patch',
              path: harness.userHome.file(...MCP_JSON_DIRS).path,
            },
          ],
        });
      },
      { timeout: 30000 },
    );

    it(
      'emits a warning that cloud agents only pick up project-level hooks',
      async () => {
        const result = await harness.run('integrate cursor -g --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('cloud');
      },
      { timeout: 30000 },
    );
  });

  it(
    'rejects --global combined with --project',
    async () => {
      const result = await harness.run(
        'integrate cursor --global --project my-project --non-interactive',
      );
      expect(result.exitCode).toBe(2);
    },
    { timeout: 30000 },
  );
});
