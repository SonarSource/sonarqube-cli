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
import { HostedMcpFixture, line, type Message, messages, response } from './fixtures/hosted-mcp.ts';

describe('hosted-mcp-bridge', () => {
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
  it.each([401, 403, 429, 500])(
    'reports HTTP %s only to the failed request and remains usable',
    async (status) => {
      fixture.handle = (message) =>
        message.id === 2
          ? new Response('private-upstream-body', { status })
          : response(message, { recovered: true });
      const session = await fixture.connect();
      session.write(line({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
      await session.waitText(`HTTP ${status}`);
      session.write(line({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));
      await session.waitText('"recovered":true');
      const result = await session.waitFinish();
      expect(result.exitCode).toBe(0);
      expect(messages(result.stdout)[1]).toMatchObject({ id: 2, error: { code: -32000 } });
      expect(result.stdout + result.stderr).not.toContain('private-upstream-body');
      expectNoDocker();
    },
  );

  it('relays SSE notifications and server requests, including the agent response', async () => {
    fixture.handle = (message) => {
      if (!message.method) return new Response(null, { status: 202 });
      const events: Message[] = [
        { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
        { jsonrpc: '2.0', id: 'server-request', method: 'ping' },
        { jsonrpc: '2.0', id: message.id, result: { complete: true } },
      ];
      return new Response(
        events.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(''),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
    const session = await fixture.connect();
    session.write(line({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    await session.waitText('"complete":true');
    session.write(line({ jsonrpc: '2.0', id: 'server-request', result: {} }));
    const result = await session.waitFinish();
    expect(result.exitCode).toBe(0);
    expect(messages(result.stdout)).toContainEqual({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    });
    expect(messages(result.stdout)).toContainEqual({
      jsonrpc: '2.0',
      id: 'server-request',
      method: 'ping',
    });
    expect(fixture.requests.map((r) => r.message)).toContainEqual({
      jsonrpc: '2.0',
      id: 'server-request',
      result: {},
    });
  });

  it('preserves the original duplicate ID request and drains concurrent replies on EOF', async () => {
    const release = Promise.withResolvers<void>();
    fixture.handle = async (message) => {
      if (message.id === 2) await release.promise;
      return response(message, { done: message.id });
    };
    const session = await fixture.connect();
    const slow: Message = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
    session.write(line(slow) + line(slow) + line({ jsonrpc: '2.0', id: 3, method: 'ping' }));
    await session.waitText('"done":3');
    const finished = session.waitFinish();
    release.resolve();
    const result = await finished;
    expect(result.exitCode).toBe(0);
    expect(fixture.requests.filter((r) => r.message.id === 2)).toHaveLength(1);
    expect(messages(result.stdout).filter((m) => m.id === 2)).toEqual([
      { jsonrpc: '2.0', id: 2, result: { done: 2 } },
    ]);
    expect(result.stderr).toContain('Ignoring duplicate pending MCP request ID');
  });

  it('forwards cancellation and exits on EOF without waiting for the cancelled request', async () => {
    const received = Promise.withResolvers<void>();
    fixture.handle = (message) => {
      if (message.id === 2) received.resolve();
      return new Response(null, { status: 202 });
    };
    const session = await fixture.connect();
    session.write(line({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    await received.promise;
    const cancellation: Message = {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 2 },
    };
    session.write(line(cancellation));
    const result = await session.waitFinish();
    expect(result.exitCode).toBe(0);
    expect(fixture.requests.map((r) => r.message)).toContainEqual(cancellation);
    expect(messages(result.stdout).filter((m) => m.id === 2)).toEqual([]);
  }, 15000);

  it('recovers from malformed input, malformed HTTP JSON, and a failed notification', async () => {
    fixture.handle = (message) =>
      message.id === 2
        ? new Response('invalid-json', { headers: { 'Content-Type': 'application/json' } })
        : message.id === undefined
          ? new Response('private-notification-body', { status: 500 })
          : response(message, { recovered: true });
    const session = await fixture.connect();
    session.write('not-json\n' + line({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    await session.waitText('"error"');
    session.write(
      line({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }) +
        line({ jsonrpc: '2.0', id: 3, method: 'ping' }),
    );
    await session.waitText('"recovered":true');
    const result = await session.waitFinish();
    expect(result.exitCode).toBe(0);
    expect(messages(result.stdout)).toHaveLength(3);
    expect(result.stdout + result.stderr).not.toContain('private-notification-body');
  }, 15000);

  it('times out missing replies, ignores late replies, and continues serving requests', async () => {
    const late = Promise.withResolvers<void>();
    fixture.handle = (message) => {
      if (message.id === 2) return new Response(null, { status: 202 });
      if (message.id === 3) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(': waiting\n\n'));
              void late.promise.then(() => {
                try {
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 3, result: { late: true } })}\n\n`,
                    ),
                  );
                  controller.close();
                } catch {
                  /* Request may already be aborted. */
                }
              });
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      return response(message, { recovered: true });
    };
    const session = await fixture.connect('run mcp', 75000);
    session.write(
      line({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) +
        line({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    );
    await session.waitText('timed out after 60 seconds', 68000);
    await session.waitText('timed out after 60 seconds', 5000);
    late.resolve();
    session.write(line({ jsonrpc: '2.0', id: 4, method: 'ping' }));
    await session.waitText('"recovered":true');
    const result = await session.waitFinish();
    expect(result.exitCode).toBe(0);
    const replies = messages(result.stdout);
    for (const id of [2, 3]) {
      expect(replies.filter((m) => m.id === id)).toHaveLength(1);
      expect(replies.find((m) => m.id === id)?.error?.message).toContain('timed out');
    }
  }, 80000);
});
