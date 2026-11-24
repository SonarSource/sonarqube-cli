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
import type { InteractiveSession, TestHarness } from '../../../harness';
import { IS_WINDOWS } from '../../../harness';
import { installRecordingStub } from '../../../harness/recording-stub.ts';

export type Message = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

export const INITIALIZE: Message = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'integration-test', version: '1' },
  },
};
export const INITIALIZED: Message = { jsonrpc: '2.0', method: 'notifications/initialized' };
export const INIT_RESULT = {
  protocolVersion: '2025-03-26',
  capabilities: { tools: {} },
  serverInfo: { name: 'fixture', version: '1' },
};
export const TOKEN = 'hosted-test-token';

export function line(message: Message): string {
  return JSON.stringify(message) + '\n';
}
export function messages(stdout: string): Message[] {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((s) => JSON.parse(s) as Message);
}
export function response(message: Message, result: unknown = {}): Response {
  return Response.json({ jsonrpc: '2.0', id: message.id, result });
}

export class HostedMcpFixture {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly requests: Array<{ message: Message; headers: Headers }> = [];
  healthStatus = 200;
  healthRequests = 0;
  healthBody = '';
  healthWait: Promise<void> | undefined;
  handle: (message: Message, request: Request) => Response | Promise<Response> = (message) =>
    response(message, { tools: [] });
  constructor(private readonly harness: TestHarness) {
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === '/api/authentication/validate')
          return Response.json({
            valid: request.headers.get('authorization') === `Bearer ${TOKEN}`,
          });
        if (path === '/api/organizations/search')
          return Response.json({
            organizations: [],
            paging: { pageIndex: 1, pageSize: 100, total: 0 },
          });
        if (path === '/mcp/health') {
          this.healthRequests++;
          if (this.healthWait) await this.healthWait;
          return new Response(this.healthBody, { status: this.healthStatus });
        }
        if (path !== '/mcp') return Response.json({});
        if (request.method === 'GET') return new Response(null, { status: 405 });
        const message = (await request.json()) as Message;
        this.requests.push({ message, headers: request.headers });
        if (message.method === 'initialize') return response(message, INIT_RESULT);
        if (message.method === 'notifications/initialized')
          return new Response(null, { status: 202 });
        return this.handle(message, request);
      },
    });
    harness.withAuth(this.server.url.origin, TOKEN);
    const bin = harness.cwd.dir('bin');
    installRecordingStub(bin.file(IS_WINDOWS ? 'docker.exe' : 'docker').path, {
      invocationsFile: harness.cwd.file('docker.jsonl').path,
      responses: { info: { exitCode: 0 }, run: { stdout: 'fallback-container\n', exitCode: 0 } },
    });
    harness.withExtraEnv({ PATH: bin.path + (IS_WINDOWS ? ';' : ':') + (process.env.PATH ?? '') });
  }
  async connect(command = 'run mcp', timeoutMs = 15000): Promise<InteractiveSession> {
    const session = this.harness.runInteractive(command, { timeoutMs });
    session.write(line(INITIALIZE));
    await session.waitText('"serverInfo"');
    session.write(line(INITIALIZED));
    return session;
  }
}
