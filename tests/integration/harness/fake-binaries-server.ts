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
