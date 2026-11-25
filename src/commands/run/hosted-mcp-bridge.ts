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

import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js';
import {
  CancelledNotificationSchema,
  InitializeResultSchema,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from '@modelcontextprotocol/sdk/types.js';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { HostedMcpClient } from '@/core/host/mcp/hosted-mcp-client.ts';

import type { McpRunOptions } from './mcp.ts';

const REQUEST_TIMEOUT_MS = 60000;
const HANGUP_EXIT_CODE = 129;
const INTERRUPTED_EXIT_CODE = 130;
const TERMINATED_EXIT_CODE = 143;

type PendingRequest = {
  method: string;
  timer: ReturnType<typeof setTimeout>;
};

/** Forward MCP messages between the agent's stdio connection and the hosted HTTP endpoint. */
export async function bridgeHostedMcp(
  client: HostedMcpClient,
  options: McpRunOptions,
): Promise<void> {
  await new HostedMcpBridge(client, options).run();
}

class HostedMcpBridge {
  private readonly agentTransport = new StdioServerTransport();
  private readonly hostedTransport: StreamableHTTPClientTransport;
  private readonly completion = Promise.withResolvers<undefined>();
  private readonly signalHandlers = new Map<NodeJS.Signals, () => void>();
  private readonly pendingRequests = new Map<RequestId, PendingRequest>();
  private activeForwards = 0;
  private inputEnded = false;
  private stopping = false;

  constructor(
    private readonly client: HostedMcpClient,
    options: McpRunOptions,
  ) {
    this.hostedTransport = new StreamableHTTPClientTransport(new URL(client.url), {
      // Delegate redirects to the CLI HTTP layer, which prevents token leaks.
      redirectPolicy: 'follow',
      fetch: (_url, requestOptions) => client.request(requestOptions ?? {}, options),
    });
  }

  async run(): Promise<void> {
    this.attachHandlers();
    try {
      await this.hostedTransport.start();
      await this.agentTransport.start();
      if (process.stdin.readableEnded) this.onInputEnd();
      await this.completion.promise;
    } catch (error) {
      throw new CommandFailedError(`Could not start hosted MCP at ${this.client.url}.`, {
        cause: error,
      });
    } finally {
      this.stop();
      this.detachProcessHandlers();
      const results = await Promise.allSettled([
        this.hostedTransport.close(),
        this.agentTransport.close(),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') this.reportError(result.reason);
      }
    }
  }

  private attachHandlers(): void {
    this.agentTransport.onmessage = (message) => {
      void this.forwardToHosted(message);
    };
    this.hostedTransport.onmessage = (message) => {
      void this.forwardToAgent(message);
    };
    this.agentTransport.onerror = (error) => {
      if (!this.stopping) this.reportError(error);
    };
    this.hostedTransport.onerror = (error) => {
      if (!this.stopping) this.reportError(error);
    };
    this.agentTransport.onclose = this.stop;
    this.hostedTransport.onclose = this.stop;
    process.stdin.once('end', this.onInputEnd);
    for (const [signal, code] of [
      ['SIGHUP', HANGUP_EXIT_CODE],
      ['SIGINT', INTERRUPTED_EXIT_CODE],
      ['SIGTERM', TERMINATED_EXIT_CODE],
    ] as const) {
      const handler = () => {
        process.exitCode = code;
        this.stop();
      };
      this.signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  private detachProcessHandlers(): void {
    process.stdin.off('end', this.onInputEnd);
    for (const [signal, handler] of this.signalHandlers) process.off(signal, handler);
    this.signalHandlers.clear();
  }

  private readonly stop = (): void => {
    this.stopping = true;
    for (const request of this.pendingRequests.values()) {
      clearTimeout(request.timer);
    }
    this.pendingRequests.clear();
    this.completion.resolve(undefined);
  };

  private errorMessage(error: unknown): string {
    // Never expose an HTTP error body: it may echo credentials or private tool arguments.
    const reason =
      error instanceof StreamableHTTPError && error.code !== undefined && error.code > 0
        ? `HTTP ${error.code}`
        : 'connection or protocol error';
    return `Hosted MCP at ${this.client.url}: ${reason}.`;
  }

  private reportError(error: unknown): void {
    process.stderr.write(`[sonarqube-cli] ${this.errorMessage(error)}\n`);
  }

  private readonly onInputEnd = (): void => {
    this.inputEnded = true;
    this.stopWhenDrained();
  };

  private stopWhenDrained(): void {
    if (this.inputEnded && this.pendingRequests.size === 0 && this.activeForwards === 0) {
      this.stop();
    }
  }

  private handleCancellation(message: JSONRPCMessage): void {
    if (!isJSONRPCNotification(message)) return;
    const cancellation = CancelledNotificationSchema.safeParse(message);
    const requestId = cancellation.success ? cancellation.data.params.requestId : undefined;
    if (requestId === undefined) return;
    const pending = this.pendingRequests.get(requestId);
    if (pending) clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);
  }

  private async forwardToHosted(message: JSONRPCMessage): Promise<void> {
    if (this.stopping) return;
    this.handleCancellation(message);
    let request: PendingRequest | undefined;
    if (isJSONRPCRequest(message)) {
      if (this.pendingRequests.has(message.id)) {
        // A second response with this ID would also be ambiguous, so preserve the original request.
        process.stderr.write('[sonarqube-cli] Ignoring duplicate pending MCP request ID.\n');
        return;
      }
      request = {
        method: message.method,
        timer: setTimeout(() => {
          void this.forwardToAgent({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32000, message: 'Hosted MCP request timed out after 60 seconds.' },
          });
        }, REQUEST_TIMEOUT_MS),
      };
      this.pendingRequests.set(message.id, request);
    }
    this.activeForwards++;
    try {
      await this.hostedTransport.send(message);
    } catch (error) {
      // The SDK reports transport errors through onerror; only the failed request needs a reply.
      if (isJSONRPCRequest(message) && this.pendingRequests.get(message.id) === request) {
        await this.forwardToAgent({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: this.errorMessage(error) },
        });
      }
    } finally {
      this.activeForwards--;
      this.stopWhenDrained();
    }
  }

  private handleInitialization(message: JSONRPCMessage, request: PendingRequest): void {
    if (request.method !== 'initialize' || !isJSONRPCResultResponse(message)) return;
    const initialization = InitializeResultSchema.safeParse(message.result);
    if (initialization.success) {
      this.hostedTransport.setProtocolVersion(initialization.data.protocolVersion);
    }
  }

  private async forwardToAgent(message: JSONRPCMessage): Promise<void> {
    if (this.stopping) return;
    if (
      (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
      message.id !== undefined
    ) {
      const request = this.pendingRequests.get(message.id);
      // Ignore late responses after a timeout or a response already delivered to the agent.
      if (!request) return;
      clearTimeout(request.timer);
      this.pendingRequests.delete(message.id);
      this.handleInitialization(message, request);
    }
    this.activeForwards++;
    try {
      await this.agentTransport.send(message);
    } catch (error) {
      this.reportError(error);
      process.exitCode = 1;
      this.stop();
    } finally {
      this.activeForwards--;
      this.stopWhenDrained();
    }
  }
}
