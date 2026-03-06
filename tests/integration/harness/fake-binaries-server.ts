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
// without real network calls. Serve the pre-built artifact or configure error responses
// via the builder before calling start().

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectPlatform, buildLocalBinaryName } from '../../../src/lib/platform-detector.js';

/** Default path to the pre-built sonar-secrets artifact used as the served binary. */
const DEFAULT_ARTIFACT_PATH = join(
  import.meta.dir,
  '..',
  'resources',
  buildLocalBinaryName(detectPlatform()),
);

type ResponseConfig = { kind: 'artifact'; path: string } | { kind: 'status'; code: number };

export class FakeBinariesServer {
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor(server: ReturnType<typeof Bun.serve>) {
    this.server = server;
  }

  /** Base URL to pass as SONAR_CLI_BINARIES_URL. */
  baseUrl(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  async stop(): Promise<void> {
    await this.server.stop(true);
  }
}

export class FakeBinariesServerBuilder {
  private _response: ResponseConfig = { kind: 'artifact', path: DEFAULT_ARTIFACT_PATH };

  /**
   * Serve the real sonar-secrets artifact so PGP verification passes.
   * Optionally override the path; defaults to tests/integration/resources/sonar-secrets.
   * This is the default behaviour when no other method is called.
   */
  withArtifact(artifactPath?: string): this {
    this._response = { kind: 'artifact', path: artifactPath ?? DEFAULT_ARTIFACT_PATH };
    return this;
  }

  /**
   * Respond with the given HTTP status code and an empty body.
   * Use this to simulate error conditions (e.g. 404 = artifact not found, 500 = server error).
   */
  withHttpStatus(statusCode: number): this {
    this._response = { kind: 'status', code: statusCode };
    return this;
  }

  start(): FakeBinariesServer {
    const response = this._response;

    if (response.kind === 'artifact' && !existsSync(response.path)) {
      throw new Error(
        `Fake binaries server: artifact not found at: ${response.path}\n` +
          `Run the setup script to download it:\n` +
          `  bash build-scripts/setup-integration-resources.sh`,
      );
    }

    const binaryFile = response.kind === 'artifact' ? Bun.file(response.path) : null;

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(_req) {
        if (binaryFile) {
          return new Response(binaryFile, {
            headers: { 'Content-Type': 'application/octet-stream' },
          });
        }
        return new Response(null, { status: (response as { kind: 'status'; code: number }).code });
      },
    });

    return new FakeBinariesServer(server);
  }
}
