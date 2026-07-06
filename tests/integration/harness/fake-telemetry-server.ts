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

// Minimal HTTP server that captures telemetry events POSTed by flushTelemetry().
// Used in place of the real TELEMETRY_ENDPOINT so tests can assert on the actual
// wire payload instead of only on state.json.

import type { StoredTelemetryEvent } from '../../../src/lib/state.js';

export class FakeTelemetryServer {
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly events: StoredTelemetryEvent[];

  private constructor(server: ReturnType<typeof Bun.serve>, events: StoredTelemetryEvent[]) {
    this.server = server;
    this.events = events;
  }

  static start(): FakeTelemetryServer {
    const events: StoredTelemetryEvent[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        events.push((await req.json()) as StoredTelemetryEvent);
        return new Response(null, { status: 200 });
      },
    });
    return new FakeTelemetryServer(server, events);
  }

  baseUrl(): string {
    return `http://localhost:${this.server.port}`;
  }

  getEvents(): StoredTelemetryEvent[] {
    return [...this.events];
  }

  /**
   * storeEvent() writes to state.json, then spawns a detached, unref'd flush-worker
   * process that POSTs asynchronously — harness.run() resolves before that POST
   * necessarily lands. Poll until the expected event count arrives instead of
   * asserting immediately after run().
   */
  async waitForEvents(count: number, timeoutMs = 5000): Promise<StoredTelemetryEvent[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.events.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.getEvents();
  }

  async stop(): Promise<void> {
    await this.server.stop(true);
  }
}
