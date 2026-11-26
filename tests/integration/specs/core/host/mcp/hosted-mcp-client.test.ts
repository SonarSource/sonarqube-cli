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

import { MCP_DEFAULT_TOOLSETS } from '@/core/host/mcp/mcp-helper.ts';

import { TestHarness } from '../../../../harness';
import {
  HostedMcpFixture,
  INIT_RESULT,
  INITIALIZE,
  line,
  type Message,
  messages,
  response,
  TOKEN,
} from '../../../run/fixtures/hosted-mcp.ts';

describe('hosted-mcp-client', () => {
  let harness: TestHarness;
  let fixture: HostedMcpFixture;
  beforeEach(async () => {
    harness = await TestHarness.create();
    fixture = new HostedMcpFixture(harness);
  });
  afterEach(async () => {
    await harness.dispose();
    await fixture.server.stop(true);
  });
  function expectNoDocker(): void {
    expect(harness.cwd.file('docker.jsonl').exists()).toBe(false);
  }
  it.each([
    { region: 'server', readOnly: false },
    { region: 'eu', readOnly: false },
    { region: 'us', readOnly: false },
    { region: 'server', readOnly: true },
  ])(
    'relays initialization and tool calls on $region with readOnly=$readOnly',
    async ({ region, readOnly }) => {
      if (region !== 'server') {
        harness.withAuth(fixture.server.url.origin, TOKEN, 'test-org');
        if (region === 'us')
          harness.withExtraEnv({
            SONARQUBE_CLI_SONARCLOUD_US_URL: fixture.server.url.origin,
            SONARQUBE_CLI_SONARCLOUD_US_API_URL: fixture.server.url.origin,
          });
      }
      const tools = [
        {
          name: 'project_tool',
          inputSchema: {
            type: 'object',
            required: ['projectKey'],
            properties: { projectKey: { type: 'string' } },
          },
        },
      ];
      fixture.handle = (message) =>
        response(
          message,
          message.method === 'tools/list'
            ? { tools }
            : { content: [{ type: 'text', text: 'tool-result' }] },
        );
      const session = await fixture.connect(
        readOnly ? 'run mcp --read-only --toolsets projects -p ignored-default' : 'run mcp',
      );
      session.write(line({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
      await session.waitText('"project_tool"');
      const call: Message = {
        jsonrpc: '2.0',
        id: 'call',
        method: 'tools/call',
        params: { name: 'project_tool', arguments: { projectKey: 'explicit-project' } },
      };
      session.write(line(call));
      await session.waitText('tool-result');
      const result = await session.waitFinish();
      expect(result.exitCode).toBe(0);
      expect(messages(result.stdout)).toEqual([
        { jsonrpc: '2.0', id: 1, result: INIT_RESULT },
        { jsonrpc: '2.0', id: 2, result: { tools } },
        {
          jsonrpc: '2.0',
          id: 'call',
          result: { content: [{ type: 'text', text: 'tool-result' }] },
        },
      ]);
      const sent = fixture.requests.find((r) => r.message.id === 'call');
      expect(sent?.message).toEqual(call);
      expect(sent?.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
      expect(sent?.headers.get('SONARQUBE_READ_ONLY')).toBe(readOnly ? 'true' : null);
      expect(sent?.headers.get('SONARQUBE_TOOLSETS')).toBe(
        readOnly ? 'projects' : MCP_DEFAULT_TOOLSETS,
      );
      expect(sent?.headers.get('SONARQUBE_ORG')).toBe(region === 'server' ? null : 'test-org');
      expect(sent?.headers.has('SONARQUBE_PROJECT_KEY')).toBe(false);
      expect(sent?.headers.get('MCP-Protocol-Version')).toBe('2025-03-26');
      expect(result.stderr).toContain(`MCP: hosted endpoint ${fixture.server.url.origin}/mcp`);
      expect(result.stderr).not.toContain('No project key found');
      expectNoDocker();
    },
  );

  it.each([401, 403])('stops startup on health HTTP %s without fallback', async (status) => {
    fixture.healthStatus = status;
    const result = await harness.runWithStdin('run mcp', line(INITIALIZE));
    expect(result.exitCode).toBe(1);
    expect(messages(result.stdout)[0].error?.message).toContain(`HTTP ${status}`);
    expect(messages(result.stdout)[0].error?.message).toContain('sonar auth login');
    expectNoDocker();
  });

  it('falls back when the health response is invalid', async () => {
    fixture.healthBody = '<html>not a health response</html>';
    const startedAt = performance.now();
    const result = await harness.run('run mcp');
    // A health-check timeout must not satisfy this case.
    expect(performance.now() - startedAt).toBeLessThan(5000);
    expect(fixture.healthRequests).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('fallback-container\n');
    expect(result.stderr).toContain('health check failed');
  }, 15000);

  it('falls back when the health check times out', async () => {
    const release = Promise.withResolvers<void>();
    fixture.healthWait = release.promise;
    try {
      const result = await harness.run('run mcp', { timeoutMs: 12000 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('fallback-container\n');
      expect(result.stderr).toContain('health check failed');
    } finally {
      release.resolve();
    }
  }, 15000);
});
