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

// Serves an installer script and fake executable over loopback for update integration tests.

export class FakeUpdateScriptServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly version: string;
  private readonly requestedPaths: string[] = [];

  constructor(version: string) {
    this.version = version;
  }

  start(): this {
    const scriptContent = ['#!/bin/sh', `echo "fake sonar v${this.version}"`].join('\n') + '\n';
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        this.requestedPaths.push(path);
        if (path === '/install.sh') {
          const installer = [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            'install_dir="$HOME/.local/share/sonarqube-cli/bin"',
            'mkdir -p "$install_dir"',
            `curl -fsSL "${this.baseUrl()}/fake-executable" -o "$install_dir/sonar"`,
            'chmod +x "$install_dir/sonar"',
          ].join('\n');
          return new Response(`${installer}\n`, { status: 200 });
        }
        if (path === '/fake-executable') {
          return new Response(scriptContent, { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      },
    });
    return this;
  }

  getRequestedPaths(): string[] {
    return [...this.requestedPaths];
  }

  baseUrl(): string {
    if (!this.server) throw new Error('Server not started');
    return `http://127.0.0.1:${this.server.port}`;
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = null;
  }
}
