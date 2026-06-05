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

// Minimal HTTP server that mimics the GitHub-hosted install script endpoint.
// Returns a shell script fragment containing the pinned version string that
// checkForUpdate() parses to determine whether an update is available.

export class FakeUpdateScriptServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly version: string;

  constructor(version: string) {
    this.version = version;
  }

  start(): this {
    const scriptContent = `#!/usr/bin/env bash\nversion="${this.version}"\necho "fake install script"\n`;
    this.server = Bun.serve({
      port: 0,
      fetch: () => new Response(scriptContent, { status: 200 }),
    });
    return this;
  }

  baseUrl(): string {
    if (!this.server) throw new Error('Server not started');
    return `http://localhost:${this.server.port}`;
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = null;
  }
}
