/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Lightweight in-process fake binaries server (Bun.serve).
// Simulates binaries.sonarsource.com so that `sonar install secrets` can be exercised
// without real network calls. Serves versioned artifacts from tests/integration/resources/
// — downloaded by setup-integration-resources.ts — and returns 404 for unknown paths.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordedRequest } from './types.js';

function resourcesDir(): string {
  return join(import.meta.dir, '..', 'resources');
}

export class FakeBinariesServer {
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly requests: RecordedRequest[];

  constructor(server: ReturnType<typeof Bun.serve>, requests: RecordedRequest[]) {
    this.server = server;
    this.requests = requests;
  }

  /** Base URL to pass as SONAR_CLI_BINARIES_URL. */
  baseUrl(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  getRecordedRequests(): RecordedRequest[] {
    return [...this.requests];
  }

  async stop(): Promise<void> {
    await this.server.stop(true);
  }
}

export class FakeBinariesServerBuilder {
  private _loadArtifacts = true;

  /**
   * Makes the server return 404 for every request, simulating artifacts being
   * unavailable (e.g. unknown version, server outage).
   */
  noArtifacts(): this {
    this._loadArtifacts = false;
    return this;
  }

  start(): Promise<FakeBinariesServer> {
    const requests: RecordedRequest[] = [];

    // Load versioned artifacts from resources (e.g. sonar-secrets-2.41.0.10709-linux-x86-64.exe)
    const files = new Map<string, Buffer>();
    if (this._loadArtifacts) {
      const dir = resourcesDir();
      for (const name of readdirSync(dir)) {
        if (/^sonar-secrets-.*\.exe(\.asc)?$/.test(name)) {
          files.set(name, readFileSync(join(dir, name)));
        }
      }
    }

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        const query: Record<string, string> = {};
        url.searchParams.forEach((v, k) => {
          query[k] = v;
        });
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k] = v;
        });

        requests.push({
          method: req.method,
          url: req.url,
          path,
          query,
          headers,
          timestamp: Date.now(),
        });

        // Match the requested filename against known artifacts
        const filename = path.split('/').at(-1) ?? '';
        const fileBytes = files.get(filename);
        if (!fileBytes) {
          return new Response('Not Found', { status: 404 });
        }

        const contentType = filename.endsWith('.asc') ? 'text/plain' : 'application/octet-stream';
        return new Response(fileBytes, { headers: { 'Content-Type': contentType } });
      },
    });

    return Promise.resolve(new FakeBinariesServer(server, requests));
  }
}
