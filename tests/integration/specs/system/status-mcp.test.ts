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
    await harness.newFakeBinariesServer().noArtifacts().start();
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
      expect(fixture.requests).toHaveLength(0);
      expect(harness.cwd.file('docker.jsonl').exists()).toBe(false);
    },
  );

  it('previews container fallback and its configured server URL without launching it', async () => {
    fixture.healthStatus = 404;
    fixture.setConfig('mcp.container.serverUrl', 'http://sonarqube:9000');
    const result = await harness.run('system status --format json');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).mcp).toMatchObject({
      connectionMode: 'container',
      serverUrl: 'http://sonarqube:9000',
      fallbackReason: 'hosted MCP health check returned HTTP 404',
      containerRuntime: { status: 'ready', runtime: 'docker' },
      startupError: null,
    });
    expect(fixture.requests).toHaveLength(0);
    expect(harness.cwd.file('docker.jsonl').asText()).not.toContain('"run"');
  }, 15000);

  it('previews configured stdio without probing hosted MCP', async () => {
    fixture.setConfig('mcp.transport', 'stdio');
    const result = await harness.run('system status --format json');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).mcp).toMatchObject({
      transportSelection: { mode: 'stdio', source: 'config' },
      connectionMode: 'container',
      fallbackReason: null,
      startupError: null,
      containerRuntime: { status: 'ready' },
    });
    expect(fixture.healthRequests).toBe(0);
  }, 15000);

  it.each(['server', 'cloud'])(
    'reports unavailable configured HTTP on %s without container fallback',
    async (kind) => {
      if (kind === 'cloud') harness.withAuth(fixture.server.url.origin, TOKEN, 'test-org');
      fixture.setConfig('mcp.transport', 'http');
      fixture.healthStatus = 404;
      const result = await harness.run('system status --format json');
      expect(result.exitCode).toBe(0);
      const mcp = JSON.parse(result.stdout).mcp;
      expect(mcp.startupError).toContain('Hosted MCP unavailable');
      if (kind === 'server') {
        expect(mcp.startupError).toContain(
          'For SonarQube Server 2026.3+, ask an administrator to configure and enable hosted MCP.',
        );
      } else {
        expect(mcp.startupError).not.toContain('ask an administrator');
      }
      expect(mcp.connectionMode).toBeNull();
      expect(mcp.containerRuntime).toBeNull();
      expect(harness.cwd.file('docker.jsonl').exists()).toBe(false);
    },
    15000,
  );

  it('reports an unreachable server as unhealthy even when the container runtime is ready', async () => {
    await fixture.server.stop(true);
    const result = await harness.run('system status --format json');
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.mcp.connectionMode).toBe('container');
    expect(data.mcp.containerRuntime.status).toBe('ready');
    expect(data.healthy).toBe(false);
    expect(data.mcp.fallbackReason).toBe('hosted MCP health check failed');
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
