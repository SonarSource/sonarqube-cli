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

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('sonar tui', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function authenticate() {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), 'test-token', 'test-org');
    return server.baseUrl();
  }

  function stub(name = 'local tui', exitCode = 0) {
    const directory = join(harness.cwd.path, 'bin');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, name);
    writeFileSync(
      path,
      `#!${Bun.which('bun')}\nconsole.log(JSON.stringify({ token: process.env.SONAR_TOKEN, url: process.env.SONAR_HOST_URL, org: process.env.SONAR_ORGANIZATION, project: process.env.SONAR_TUI_PROJECT, invocation: process.env.SONAR_TUI_INVOCATION_ID, args: process.argv.slice(2) })); process.exit(${exitCode});\n`,
    );
    chmodSync(path, 0o755);
    return path;
  }

  it('shows help without authentication or an installed TUI', async () => {
    const result = await harness.run('tui --help');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Explore SonarQube in your terminal');
  });

  it('reports an unavailable override with a build hint', async () => {
    await authenticate();
    const result = await harness.run('tui', {
      extraEnv: { SONAR_TUI_BINARY: join(harness.cwd.path, 'missing') },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('TUI binary not found');
    expect(result.stderr).toContain('cargo build --release');
  });

  it('requires authentication before launching a TUI', async () => {
    const result = await harness.run('tui', {
      extraEnv: { SONAR_TUI_BINARY: join(harness.cwd.path, 'missing') },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain('TUI binary not found');
  });

  it('refuses to reuse the active token for a different project connection', async () => {
    const url = await authenticate();
    harness
      .state()
      .withKnownServerProjectMapping(harness.cwd.path, 'project-key', url, 'other-org');
    const result = await harness.run('tui', {
      extraEnv: { SONAR_TUI_BINARY: join(harness.cwd.path, 'missing') },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Not authenticated for the discovered project connection');
    expect(result.stderr).not.toContain('TUI binary not found');
  });

  it('rejects an empty override', async () => {
    await authenticate();
    const result = await harness.run('tui', { extraEnv: { SONAR_TUI_BINARY: ' ' } });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('SONAR_TUI_BINARY must not be empty');
  });

  it.skipIf(process.platform === 'win32')(
    'launches an override with resolved credentials and no token argv',
    async () => {
      const url = await authenticate();
      const result = await harness.run('tui', {
        extraEnv: {
          SONAR_TUI_BINARY: stub(),
          SONAR_TOKEN: 'stale-token',
          SONAR_HOST_URL: 'https://stale.invalid',
          SONAR_ORGANIZATION: 'stale-org',
          SONAR_TUI_PROJECT: 'stale-project',
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"token":"test-token"');
      expect(result.stdout).toContain(`"url":"${url}"`);
      expect(result.stdout).toContain('"org":"test-org"');
      expect(result.stdout).toContain('"project":""');
      expect(result.stdout).toContain('"args":[]');
      expect(result.stdout).not.toContain('stale-');
    },
  );

  it.skipIf(process.platform === 'win32')('propagates the child exit code', async () => {
    await authenticate();
    const result = await harness.run('tui', {
      extraEnv: { SONAR_TUI_BINARY: stub('failed-tui', 7) },
    });
    expect(result.exitCode).toBe(7);
  });

  it.skipIf(process.platform === 'win32')('finds sonar-tui on PATH', async () => {
    await authenticate();
    stub('sonar-tui');
    const result = await harness.run('tui', {
      extraEnv: { PATH: `${join(harness.cwd.path, 'bin')}:${process.env.PATH}` },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"token":"test-token"');
  });

  it.skipIf(process.platform === 'win32')(
    'uses the project connection rather than the active connection',
    async () => {
      const url = await authenticate();
      harness
        .state()
        .withKeychainToken(url, 'project-token', 'project-org')
        .withKnownServerProjectMapping(harness.cwd.path, 'project-key', url, 'project-org');
      const result = await harness.run('tui', {
        extraEnv: { SONAR_TUI_BINARY: stub() },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"token":"project-token"');
      expect(result.stdout).toContain('"org":"project-org"');
      expect(result.stdout).toContain('"project":"project-key"');
    },
  );
});
