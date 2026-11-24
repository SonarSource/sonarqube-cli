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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';
import { HostedMcpFixture, TOKEN } from '../run/fixtures/hosted-mcp.ts';

describe('system status MCP endpoint', () => {
  let harness: TestHarness;
  let fixture: HostedMcpFixture;
  beforeEach(async () => {
    harness = await TestHarness.create();
    fixture = new HostedMcpFixture(harness);
    await harness.newFakeBinariesServer().start();
  });
  afterEach(async () => {
    await harness.dispose();
    await fixture.server.stop(true);
  });

  it.each(['server', 'cloud'])(
    'previews the %s hosted endpoint without starting MCP',
    async (kind) => {
      if (kind === 'cloud') harness.withAuth(fixture.server.url.origin, TOKEN, 'test-org');
      const result = await harness.run('system status --format json');
      expect(result.exitCode, result.stderr).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.mcp).toMatchObject({
        connectionMode: 'hosted',
        serverUrl: `${fixture.server.url.origin}/mcp`,
        fallbackReason: null,
        startupError: null,
      });
      expect(data.mcpRuntime).toBeNull();
      const text = await harness.run('system status');
      expect(text.stdout).toContain(
        `MCP (sonar run mcp --transport auto)\n  • Transport: HTTP (hosted)\n  • Endpoint: ${fixture.server.url.origin}/mcp`,
      );
      expect(text.stdout).not.toContain('needs Docker');
      expect(fixture.requests).toHaveLength(0);
      expect(harness.cwd.file('docker.jsonl').exists()).toBe(false);
    },
  );

  it('previews container fallback and its configured server URL without launching it', async () => {
    fixture.healthStatus = 404;
    await harness.run('config set mcp.container.serverUrl http://sonarqube:9000');
    const result = await harness.run('system status --format json');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).mcp).toMatchObject({
      connectionMode: 'container',
      serverUrl: 'http://sonarqube:9000',
      fallbackReason: 'hosted MCP health check returned HTTP 404',
      containerRuntime: { status: 'ready', runtime: 'docker' },
      startupError: null,
    });
    const text = await harness.run('system status');
    expect(text.stdout).toContain(
      'MCP (sonar run mcp --transport auto)\n' +
        '  • Transport: stdio (local container)\n' +
        '  • SonarQube server URL: http://sonarqube:9000\n' +
        '  • Using container because hosted MCP health check returned HTTP 404.\n' +
        '  • Container runtime: READY (docker)',
    );
    expect(fixture.requests).toHaveLength(0);
    expect(harness.cwd.file('docker.jsonl').asText()).not.toContain('"run"');
  });

  it('reports an unreachable server as unhealthy even when the container runtime is ready', async () => {
    await fixture.server.stop(true);
    const result = await harness.run('system status --format json');
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.mcp.connectionMode).toBe('container');
    expect(data.mcp.containerRuntime.status).toBe('ready');
    expect(data.healthy).toBe(false);
    const text = await harness.run('system status');
    expect(text.stdout).toContain('Using container because hosted MCP health check failed.');
  });

  it.each(['unauthenticated', 'unauthorized', 'invalid certificate', 'invalid token'])(
    'reports %s as a startup error, not fallback',
    async (failure) => {
      if (failure === 'unauthenticated') harness.clearAuth();
      else if (failure === 'unauthorized') fixture.healthStatus = 401;
      else if (failure === 'invalid token')
        harness.withAuth(fixture.server.url.origin, 'invalid-token', 'test-org');
      else harness.withExtraEnv({ SONAR_CA_CERT: harness.cwd.file('missing.pem').path });
      const result = await harness.run('system status --format json');
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.mcp.connectionMode).toBeNull();
      expect(data.mcp.serverUrl).toBeNull();
      expect(data.mcp.fallbackReason).toBeNull();
      expect(data.mcp.startupError).toBeTruthy();
      if (failure === 'unauthenticated') {
        expect(data.mcp.startupError).toBe(
          "Not authenticated. Run 'sonar auth login' to authenticate.",
        );
      }
      expect(data.healthy).toBe(failure === 'unauthorized');
      if (failure === 'invalid token') {
        expect(fixture.healthRequests).toBe(1);
        expect(data.mcp.startupError).toContain('Invalid token');
      }
      if (failure === 'unauthenticated' || failure === 'invalid token') {
        expect(
          data.recommendations.filter((message: string) => message.includes('sonar auth login')),
        ).toHaveLength(1);
      }
      expect(harness.cwd.file('docker.jsonl').exists()).toBe(false);
      expect(fixture.requests).toHaveLength(0);
    },
  );

  it('does not require a container runtime when MCP is not configured', async () => {
    fixture.healthStatus = 404;
    harness.withExtraEnv({
      PATH: harness.cwd.dir('empty-bin').path,
      SONARQUBE_CLI_MCP_WSL: 'never',
    });
    const result = await harness.run('system status --format json');
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.mcp.containerRuntime.status).toBe('not_found');
    expect(data.healthy).toBe(true);
    expect(data.recommendations.join('\n')).not.toContain('MCP');
  });
});
